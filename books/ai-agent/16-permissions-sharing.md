# 16. 權限與共享

## 定位

這個子系統回答兩個看似相似、實際上正交的問題:

1. **「這個使用者被允許使用某個功能嗎?」** — 例如「USER 角色的人能不能建立 agent?能不能把 agent 分享出去?能不能公開分享?能不能搜尋其他使用者(people picker)?」。這是**功能開關(feature gate)**,答案只跟使用者的**角色(role)**有關,跟具體是哪個 agent 無關。
2. **「這個使用者對『這一個特定資源』有什麼權限?」** — 例如「Alice 能看 agent X,但不能編輯;Bob 是 owner 可以刪掉它;整個公司(public)可以使用它」。這是**資源層存取控制(resource-level ACL)**,答案跟「使用者 × 資源」這一組配對有關。

LibreChat 把這兩件事做成**兩層獨立疊加的權限系統**,兩層都必須通過才放行:

- **第一層:RBAC 功能開關**。以 `PermissionTypes`(功能領域,如 `AGENTS`、`MARKETPLACE`)× `Permissions`(動作,如 `USE`、`CREATE`、`SHARE`)組成一張布林矩陣,存在**角色文件**(`Role`)裡。中介層 `generateCheckAccess` 檢查這層。
- **第二層:資源 ACL**。以 bitmask(`PermissionBits`:`VIEW`/`EDIT`/`DELETE`/`SHARE`)描述「某個 principal 對某個 resource 有哪些位元權限」,一筆一筆存在 `AclEntry` 集合。中介層 `canAccessResource`(及其 agent 特化版 `canAccessAgentResource`)檢查這層。

一條典型的 agent 編輯請求 `PATCH /agents/:id` 會**同時穿過兩層**:先 `checkAgentCreate`(第一層:你這個角色被允許建立/編輯 agent 嗎?),再 `canAccessAgentResource({ requiredPermission: EDIT })`(第二層:你對這個特定 agent 有 EDIT bit 嗎?)(`api/server/routes/agents/v1.js:108`)。理解「兩層都要過」是理解整份文件的關鍵。

這套機制服務的資源型別統一由 `ResourceType` enum 定義:`agent`、`promptGroup`、`mcpServer`、`remoteAgent`、`skill`、`sharedLink`(`packages/data-provider/src/accessPermissions.ts:45`)。本文以 agent 為主線,其他資源共用同一套機制。與這層相鄰的還有一個第三層 admin capability 系統(`ResourceCapabilityMap`),本文只說明它如何在 ACL 檢查中作為「繞過(bypass)」,細節見 admin 相關文件。

---

## 核心概念

### 兩個平行的 enum 家族,不要混淆

LibreChat 有兩組長得很像但完全不同的權限詞彙,這是初讀原始碼最大的混淆來源:

| 家族 | 定義處 | 用途 | 值的形態 |
|---|---|---|---|
| `PermissionTypes` + `Permissions` | `permissions.ts` | 第一層 RBAC 功能開關 | 字串 enum(`'AGENTS'` × `'CREATE'`),存成布林 |
| `PermissionBits` + `AccessRoleIds` | `accessPermissions.ts` | 第二層資源 ACL | 位元整數(`VIEW=1`),存成 bitmask |

`Permissions.SHARE`(第一層,「這個角色被允許分享 agent」)和 `PermissionBits.SHARE`(第二層,「這個使用者對這個 agent 有分享位元」)是**兩個不同的東西**,而且分享操作**同時需要兩者**(見下文流程)。

### 第一層:RBAC 布林矩陣

`PermissionTypes` 是功能領域(`AGENTS`、`PROMPTS`、`MEMORIES`、`MARKETPLACE`、`PEOPLE_PICKER`、`MCP_SERVERS`、`SHARED_LINKS`… 共 16 個,`permissions.ts:6`)。`Permissions` 是動作(`USE`、`CREATE`、`UPDATE`、`READ`、`SHARE`、`SHARE_PUBLIC`、`VIEW_USERS`、`VIEW_GROUPS`、`VIEW_ROLES`、`CONFIGURE_OBO`…,`permissions.ts:129`)。

每個功能領域只用到動作的一個子集,用 Zod schema 明確定義。例如 `agentPermissionsSchema` 只有四個動作,且各有預設值(`permissions.ts:173`):

```
agentPermissionsSchema = { USE: true, CREATE: true, SHARE: false, SHARE_PUBLIC: false }
```

注意預設值本身就是一種**安全預設**:一般使用者預設可以「用」和「建」agent,但**不能分享**(`SHARE: false`)、**不能公開**(`SHARE_PUBLIC: false`)。所有領域的 schema 合成一張 `permissionsSchema`(`permissions.ts:256`),這張表就是一個角色的 `permissions` 欄位型別。

`SystemRoles` 只有兩個:`ADMIN` 與 `USER`(`roles.ts:26`)。`roleDefaults`(`roles.ts:138`)是這兩個角色的出廠權限:ADMIN 幾乎全開(含 `SHARE`、`SHARE_PUBLIC`、`CONFIGURE_OBO`);USER 保守(能用能建,不能分享,`MARKETPLACE.USE: false`、`PEOPLE_PICKER` 全 false)。這些預設在啟動時被 seed 進 DB,之後可由管理員在 UI 覆寫。

### 第二層:PrincipalType × PermissionBits × Resource

資源 ACL 的心智模型是「**誰(principal)對哪個資源(resource)有哪些位元(permBits)**」,一筆對應一個 `AclEntry`。

- **Principal(被授權主體)** 有四種型別(`PrincipalType`,`accessPermissions.ts:16`):
  - `user` — 單一使用者(principalId = User ObjectId)
  - `group` — 使用者群組(principalId = Group ObjectId),支援本地群組與 Entra ID 群組同步
  - `role` — 整個角色(principalId = 角色名字串,如 `'USER'`),讓你能「分享給所有 USER」
  - `public` — 所有人(沒有 principalId,是 sentinel)
- **PermissionBits(位元權限)** 是可 OR 疊加的旗標(`accessPermissions.ts:57`):`VIEW=1`、`EDIT=2`、`DELETE=4`、`SHARE=8`。
- **AccessRoleIds(具名權限包)** 把常見的位元組合命名成「viewer/editor/owner」,每個 `ResourceType` 各一組(`agent_viewer`、`agent_editor`、`agent_owner`…,`accessPermissions.ts:71`)。前端 people picker 選的是這種具名角色,不是裸位元。

`RoleBits`(`packages/data-schemas/src/common/enum.ts`)定義了這些具名包對應的位元:`VIEWER=1`(VIEW)、`EDITOR=3`(VIEW|EDIT)、`MANAGER=7`、`OWNER=15`(VIEW|EDIT|DELETE|SHARE)。轉換函式 `accessRoleToPermBits`(`accessPermissions.ts:321`)把 `AccessRoleIds` 映成裸位元,`permBitsToAccessLevel`(`accessPermissions.ts:311`)反向把 bitmask 折回 `'viewer'|'editor'|'owner'|'none'` 給前端顯示。

### 為什麼「位元」而不是「等級」

權限用 bitmask 而非單一等級數字(1/2/3)的好處是**可以做集合運算**:一個使用者可能同時是「某 agent 的直接 viewer(VIEW)」又「是某群組成員,群組被授 editor(VIEW|EDIT)」——他的**有效權限(effective permissions)**是所有來源的 OR:`VIEW | (VIEW|EDIT) = VIEW|EDIT`。這個 OR 疊加是整個 ACL 系統的計算核心(`getEffectivePermissions`,`aclEntry.ts:259`)。

---

## 架構與流程

### 兩層中介層在請求路徑上的位置

```
                    HTTP request: PATCH /agents/:id
                                │
                    ┌───────────▼────────────┐
                    │  requireJwtAuth         │  → req.user { id, role, tenantId }
                    └───────────┬────────────┘
                                │
        ┌───────────────────────▼───────────────────────┐
        │ 第一層 RBAC: checkAgentCreate                   │
        │ generateCheckAccess(AGENTS, [USE, CREATE])     │
        │   → getRoleByName(user.role)                   │
        │   → role.permissions.AGENTS.CREATE === true ?  │  ✗ → 403
        └───────────────────────┬───────────────────────┘
                                │ ✓
        ┌───────────────────────▼───────────────────────┐
        │ 第二層 ACL: canAccessAgentResource(EDIT=2)      │
        │   → capability bypass? (MANAGE_AGENTS) ────────┼── ✓ → next()
        │   → resolveAgentId(:id) → ObjectId             │
        │   → checkPermission(userId, role, EDIT)        │
        │       → getUserPrincipals(user+role+groups+pub)│
        │       → AclEntry.findOne(permBits ⊇ EDIT)      │  ✗ → 403
        └───────────────────────┬───────────────────────┘
                                │ ✓
                    ┌───────────▼────────────┐
                    │   v1.updateAgent        │
                    └─────────────────────────┘
```

### 第一層:generateCheckAccess 的運作

`generateCheckAccess`(`packages/api/src/middleware/access.ts:164`)是一個中介層工廠。核心邏輯在 `checkAccess`(`access.ts:85`):

1. 若有 `skipCheck(req)` 回 true 就直接放行(例如非 agents endpoint 的請求跳過 agent 檢查)。
2. 取 `req.user.role`,用注入的 `getRoleByName` 撈角色文件。
3. 取 `role.permissions[permissionType]`,用 `permissions.every(...)` 檢查**所有**要求的動作都是 `true`。
4. 支援 `bodyProps` 逃生門:某個動作即使角色沒開,只要 `req.body` 帶了指定屬性也算通過(用於「有帶 X 欄位才需要 Y 權限」的情境)。

有一個效能細節:`checkAccessWithRequestCache`(`access.ts:130`)用一個掛在 `req` 上的 `Map<cacheKey, Promise<boolean>>` 做**同一請求內**的去重快取,cacheKey 由 `permissionType:permissions:userId:role` 組成(`access.ts:67`)。因為一個請求可能觸發多次同樣的角色權限檢查,快取 Promise(而非結果)可避免重複 DB 查詢又天然處理併發。

### 第二層:canAccessResource 的運作

`canAccessResource`(`api/server/middleware/accessResources/canAccessResource.js:35`)是通用工廠,設定 `resourceType`、`requiredPermission`(位元)、`resourceIdParam`、以及可選的 `idResolver`。流程:

1. 從 route param 取原始資源 ID;無 ID → 400,未登入 → 401。
2. **Capability bypass**:查 `ResourceCapabilityMap[resourceType]`(`packages/data-schemas/src/admin/capabilities.ts:149`),若使用者有對應的 admin capability(如 `MANAGE_AGENTS`),**直接放行**、跳過 ACL。這讓管理員無需被逐一授權即可管理所有資源。
3. **ID 解析**:agent 用的是自訂字串 ID(如 `agent_abc123`),ACL 存的是 Mongo ObjectId。`idResolver`(agent 的是 `resolveAgentId` → `getAgent({id})`,`canAccessAgentResource.js:12`)把自訂 ID 換成 ObjectId;解析不到 → 404。
4. `checkPermission`(`PermissionService.js:138`)做真正的 ACL 判斷。
5. 通過則把 `req.resourceAccess = { resourceType, resourceId, customResourceId, permission, userId }` 掛上供 handler 使用,再 `next()`;否則 403。

`checkPermission` 的內部:先 `getUserPrincipals({ userId, role })`(`userGroup.ts:395`)把使用者展開成一組 principals —— `[user, role, ...groups, public]`(注意**角色本身也是一個 principal**,所以「分享給所有 USER」才可行);再 `hasPermission(principals, resourceType, resourceId, bit)`(`aclEntry.ts:228`)查是否存在任一 `AclEntry` 其 `permBits` 是 `requiredBit` 的超集。

### 分享一個 agent 的完整流程(兩層協同)

`PUT /api/permissions/:resourceType/:resourceId`(`api/server/routes/accessPermissions.js:176`)串了四個中介層,展示兩層如何協同:

```
checkResourcePermissionAccess(SHARE)   ← 第二層:你對這資源有 ACL 的 SHARE bit 嗎?
   → checkShareAccess                  ← 第一層:你的角色被允許 SHARE 這類資源嗎?
      → checkSharePublicAccess          ← 第一層:若要公開,角色被允許 SHARE_PUBLIC 嗎?
         → rejectSharedLinkOwnerPermissionChanges  ← 商業規則守衛
            → updateResourcePermissions ← 真正寫入 ACL
```

- `checkResourcePermissionAccess(PermissionBits.SHARE)`(`accessPermissions.js:55`)按 `resourceType` 動態選對應的 `canAccessResource`,要求呼叫者對**這個具體資源**有 `SHARE` 位元(通常只有 owner 有)。
- `checkShareAccess`(`share.ts:164`)檢查**角色層**的 `Permissions.SHARE`。它會先看 capability bypass(`hasResourceManagementCapability`),再看角色權限。
- `checkSharePublicAccess`(`share.ts:205`)**只在請求包含 public principal 時**才要求 `Permissions.SHARE_PUBLIC`。這是「公開分享」比「分享給特定人」更高的門檻。
- 真正寫入由 `updateResourcePermissions`(controller)→ `bulkUpdateResourcePermissions`(`PermissionService.js:692`)完成:先 `ensurePrincipalExists`/`ensureGroupPrincipalExists` 確保 principal 在本地 DB 有記錄(Entra 使用者/群組會被 lazy 建立),再組 bulk upsert/delete 一次寫入 `AclEntry`,能開 transaction 就開。

### 建立 agent 時自動授 owner

Agent 一被建立,立刻在同一個 `Promise.all` 裡授予建立者 `AGENT_OWNER` 與 `REMOTE_AGENT_OWNER` 兩筆 ACL(`api/server/controllers/agents/v1.js:436`)。owner = `VIEW|EDIT|DELETE|SHARE`,所以建立者天生能完整操作自己的 agent。這也解釋了為什麼「擁有」在 LibreChat 不是一個 `agent.author` 欄位比對,而是「有一筆 DELETE bit 的 ACL」——所有權被統一建模成 ACL 的一種。

### 列表與市集(marketplace)

`GET /agents` 的 `getListAgentsHandler`(`v1.js:980`)展示 ACL 如何驅動列表查詢:

1. `findAccessibleResources({ userId, role, AGENT, VIEW })`(`aclEntry.ts:491`)一次撈出使用者**有 VIEW 權限的所有 agent ObjectId**(透過 principals 的 `$or` + 位元超集比對 + `distinct('resourceId')`)。
2. `findPubliclyAccessibleResources`(`aclEntry.ts:541`)另外撈出 public 的集合,供 UI 標示「這個是公開的」。
3. 用 `accessibleIds` 當 `$in` 過濾器去查真正的 agent 文件。

**市集與 `is_promoted`**:市集是「探索別人公開的 agent」的介面。第一層用 `PermissionTypes.MARKETPLACE`(USER 預設 `false`,需管理員開啟)gate 進入權;`is_promoted` 是 agent 上的布林欄位(`packages/data-schemas/src/schema/agent.ts:107`,有索引),代表「被管理員精選推薦」。列表查詢用 `promoted` query param 過濾:`promoted=1` → `filter.is_promoted = true`,`promoted=0` → `{ $ne: true }`(`v1.js:1004`)。搭配 `category`(agent 的分類欄位,預設 `'general'`)一起做市集的分頁瀏覽。**關鍵**:即使在市集看到一個 agent,能不能真的用它仍由第二層 ACL(該 agent 有沒有 public 的 VIEW entry)決定——市集只是「發現」層,不繞過 ACL。

---

## 關鍵資料結構

### AclEntry(第二層核心,`packages/data-schemas/src/schema/aclEntry.ts`)

一筆 = 「某 principal 對某 resource 的一組位元」。

| 欄位 | 型別 | 用途 |
|---|---|---|
| `principalType` | enum `user\|group\|role\|public` | 主體型別 |
| `principalId` | Mixed(ObjectId 或 String) | user/group 是 ObjectId;role 是角色名字串;public 無此欄位 |
| `principalModel` | enum `User\|Group\|Role` | Mongoose `refPath`,public 無 |
| `resourceType` | enum `ResourceType` | 資源型別 |
| `resourceId` | ObjectId | 資源 ID(有索引) |
| `permBits` | Number `[0, MAX_PERM_BITS]` | 位元權限,`min:0 max:15`、須為整數 |
| `roleId` | ObjectId → AccessRole | 授權時用的具名角色(供反查顯示) |
| `grantedBy` | ObjectId → User | 誰授的 |
| `grantedAt` | Date | 何時授的 |
| `expiredAt` | Date(可選) | TTL 過期時間;有 `expireAfterSeconds:0` 索引自動刪 |
| `inheritedFrom` | ObjectId(sparse) | 專案層繼承來源(預留) |
| `tenantId` | String(index) | 多租戶隔離 |

索引設計反映查詢型態:`{principalId, principalType, resourceType, resourceId}`(判斷單一資源)、`{resourceId, principalType, principalId}`(列出某資源的所有分享對象)、`{principalId, permBits, resourceType}`(`findAccessibleResources` 的列表查詢)、`{principalType, resourceType, permBits, resourceId}`(public 專用)。

### AccessRole(具名權限包,`packages/data-schemas/src/schema/accessRole.ts`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `accessRoleId` | String(index) | 如 `agent_viewer`,全域唯一(+tenantId) |
| `name` / `description` | String | i18n key(如 `com_ui_role_viewer`) |
| `resourceType` | enum | 這個角色屬於哪類資源 |
| `permBits` | Number | 對應的裸位元(來自 `RoleBits`) |

啟動時由 `seedDefaultRoles`(`accessRole.ts:124`)用 `$setOnInsert` upsert 六種資源 × (viewer/editor/owner) 的組合(sharedLink 只有 viewer/owner)。`getRoleForPermissions`(`accessRole.ts:271`)能在無精確匹配時,回傳「不超過給定位元的最接近角色」。

### Role(第一層 RBAC,`packages/data-provider/src/roles.ts`)

`{ name: string, permissions: permissionsSchema }`。`permissions` 是 `PermissionTypes → { Permissions → boolean }` 的巢狀布林表。出廠值見 `roleDefaults`(`roles.ts:138`)。

### Group(`packages/data-schemas/src/schema/group.ts`)

| 欄位 | 型別 | 用途 |
|---|---|---|
| `name` / `email` / `description` / `avatar` | String | 群組基本資料 |
| `memberIds` | `String[]` | **成員 ID 列表**;本地群組存 user `_id` 字串,Entra 群組存 `idOnTheSource` |
| `source` | enum `local\|entra` | 來源 |
| `idOnTheSource` | String(sparse unique) | Entra 群組的外部 ID |
| `tenantId` | String | 租戶隔離 |

`getUserGroups` → `findGroupsByMemberId` 用 `user.idOnTheSource || user._id` 去比對 `memberIds`,所以本地與 Entra 成員共用同一查詢。

---

## 關鍵實作細節與陷阱

### 陷阱一:$bitsAllSet 不能用,改用「超集列舉 + $in」

判斷「一筆 entry 的 `permBits` 是否包含要求的位元」在 Mongo 直覺上會用 `$bitsAllSet`,但 **Azure Cosmos DB for MongoDB 不支援這個運算子**(issue #12729)。LibreChat 改用 `permissionBitSupersets(requiredBits)`(`aclEntry.ts:50`):在 `[0, MAX_PERM_BITS]` 範圍內**列舉出所有「位元是 requiredBits 超集」的整數**,再用 `permBits: { $in: [...] }` 查詢。4 個位元最多 16 個候選值,可接受。

這帶來一連串防禦性設計:
- `MAX_PERM_BITS`(`common/permissions.ts:15`)= 所有 `PermissionBits` 的 OR。啟動時若它為 0(enum 被改壞)或 > 255(位元太多,`$in` 會爆炸)就**直接 throw 讓程序啟動失敗**——寧可爆炸也不要靜默拒絕所有權限。
- 列舉結果用 `Map` memoize 且 `Object.freeze`,避免共享陣列被誤改成「match everything」。
- 使用者可控的 `requiredBits`(如 query param)若超出範圍,回傳共享的凍結空陣列且**不進快取**,防止攻擊者用任意整數把 process-global 快取撐爆。空 `$in` 正確地匹配零筆,對「要求系統不認識的位元」正是正確行為。

**移植啟示**:PostgreSQL 沒這個問題,直接用 `(perm_bits & :required) = :required` 即可,這整套列舉法在新技術棧完全不需要。

### 陷阱二:有效權限是 OR 疊加,不是取最大

`getEffectivePermissions`(`aclEntry.ts:259`)把某使用者所有 principals(user + role + groups + public)命中的 entry 的 `permBits` 全部 OR 起來。所以一個人的最終權限是「所有身分來源的聯集」。撤銷某個群組的權限不代表使用者就沒權限了——他可能還從別的來源拿到。這對「移除分享」的正確性很重要:UI 上把 Alice 移除,只是刪掉 `principalType:user, principalId:Alice` 那一筆,如果 Alice 還在某個有權限的群組,她仍看得到。

### 陷阱三:「唯一擁有者」判定要跨 principal 檢查

刪除使用者前要清理他「獨佔擁有」的資源。`getSoleOwnedResourceIds`(`aclEntry.ts:567`)先找出使用者有 DELETE bit 的資源,再用 aggregation 排除「還有別的 principal(別的 user 或任何 group/role/public)也有 DELETE」的資源。只有真正沒有其他擁有者的才算「sole owned」。這是正確處理「共同擁有」的邊界。

### 陷阱四:role principal 的 ID 是字串,不能當 ObjectId 處理

`grantPermission`(`aclEntry.ts:341`)在組 query 時特別判斷:`user`/`group` 的 principalId 轉成 `ObjectId`,但 `role` 的 principalId 是**角色名字串**(如 `'USER'`),保持原樣。多處程式碼都有 `principalType !== PrincipalType.ROLE` 的分支處理這個不對稱。忽略它會導致 `new ObjectId('USER')` 直接拋錯。

### 陷阱五:public principal 沒有 principalId

所有查詢在組 `$or` 條件時,對 `public` 型別**故意省略 principalId**(`aclEntry.ts:207` 等多處用 `...(p.principalType !== PUBLIC && { principalId })`)。schema 也把 principalId/principalModel 對 public 設為非必填。若不小心給 public 補了 principalId,查詢會匹配不到任何 public entry。

### 陷阱六:兩層的 SHARE 名稱衝突

如前述,`Permissions.SHARE`(第一層角色能力)與 `PermissionBits.SHARE`(第二層資源位元)同名但不同義。分享 API 兩者都查:`checkResourcePermissionAccess(PermissionBits.SHARE)` 要你對資源有位元 SHARE(通常是 owner),`checkShareAccess` 要你的角色被允許 SHARE。一個非 owner 但角色能 SHARE 的人**仍分享不了別人的 agent**,因為第二層擋下;一個 owner 但角色 `SHARE:false` 的人也分享不了。這是刻意的「AND」。

### 陷阱七:capability bypass 是靜默的高權限路徑

`canAccessResource` 與 `checkShareAccess` 都在最前面查 admin capability 並可能**完全跳過 ACL**。這是雙面刃:方便管理員,但也意味著 capability 的授予要極度謹慎。程式碼在 capability 檢查失敗(拋錯)時**故意 deny bypass**(`canAccessResource.js:78`)而非放行,是正確的 fail-closed。

### 效能考量:批次查詢

列表場景一次要判斷幾十個 agent 的權限。`getEffectivePermissionsForResources`(`aclEntry.ts:296`)用單一 `resourceId: { $in: [...] }` 查詢一次撈完再在記憶體 OR 出 `Map<resourceId, bits>`,避免 N+1。`bulkUpdateResourcePermissions` 也把多個 principal 的變更組成一次 `bulkWrite`。CLAUDE.md 反覆強調的「少迭代、用 Map/Set」在此系統體現得很直接。

### 安全考量:多租戶隔離靠 ALS,不靠參數

`getUserPrincipals` 的群組查詢**依賴 AsyncLocalStorage 的租戶 context**(由 `requireJwtAuth` 設定),而非顯式 tenantId 參數(`userGroup.ts:380` 附近註解)。在請求外(啟動、背景工作)呼叫會導致查詢未受租戶限制。移植時要留意這種「隱式 context」的坑。

---

## 設計決策分析

### 為什麼要兩層而不是一層

若只有 RBAC(第一層),你無法表達「Alice 能編這個 agent 但不能編那個」;若只有 ACL(第二層),你無法便宜地表達「這個角色的人一律不准建立 agent」——你得替每個 agent 逐一設定。兩層分工:**RBAC 管「能不能做這類事」(粗粒度、跟資源無關、快取友善),ACL 管「對這個東西能做什麼」(細粒度、per-resource)**。這是成熟權限系統的常見分層,LibreChat 的實作乾淨。

### 把「所有權」建模成 ACL 的一種是明智的

沒有 `agent.ownerId` 這種特例欄位,owner 就是「有 DELETE/SHARE bit 的 ACL entry」。好處:所有權限判斷走同一條 `getEffectivePermissions` 路徑,沒有「先查 owner 再查 ACL」的雙重邏輯;轉移所有權 = 改 ACL;共同擁有天然支援。代價:判斷「誰是唯一擁有者」需要 aggregation(陷阱三),以及每次建立資源要多寫一筆 ACL。整體是好的取捨。

### bitmask + 具名角色的雙表示

底層存 bitmask(可 OR、可比較、省空間),對外用 `AccessRoleIds`(viewer/editor/owner,人類可讀、前端好選)。`accessRoleToPermBits` / `permBitsToAccessLevel` 做雙向轉換。這讓「未來要加一個 `DELETE` 但不能 `SHARE` 的 manager 角色」很容易(已有 `RoleBits.MANAGER=7`),不必改 UI 的位元運算。缺點是多了一層映射與 seed 資料要維護。

### 缺點與若重做的選擇

- **Cosmos 相容性稅**:整套 `permissionBitSupersets` 列舉法是為了繞過 `$bitsAllSet` 而生的複雜度,並附帶一堆防禦性檢查。若目標資料庫確定支援位元查詢(PostgreSQL、原生 MongoDB `$bitsAllSet`),這層可整個砍掉。
- **兩個 SHARE 同名**:命名衝突是真實的認知負擔。若重做,我會把第一層叫 `CAN_SHARE`(能力)、第二層叫 `SHARE` bit,或反之,明確區分。
- **Entra 群組成員存 `idOnTheSource` 字串陣列**:`memberIds` 是非正規化字串陣列,大群組更新成本高、無法用 JOIN。若重做會用關聯表 `group_members(group_id, user_id)`。
- **capability bypass 分散在多處**:每個 `canAccessXxx` 與 share middleware 各自實作 bypass,容易漏。集中成一個 `authorize()` 入口會更安全。

---

## 移植到新技術棧的建議(PostgreSQL + Hono + Next.js + Redis)

> 技術棧中 PostgreSQL/Hono/Next.js/Redis 已定案;AI 框架(LangGraph / LangChain / deepagents / Vercel AI SDK)尚未定案,完整選型比較見 19-framework-options.md。本節內容與框架選擇基本無關,唯一涉及框架的地方見下方「AI 框架的對應」小節。

### 資料模型:直接落地成關聯表

PostgreSQL 讓這套 ACL 更自然,而且能砍掉 Cosmos 相容層。核心 DDL 草案:

```sql
-- 第一層 RBAC:角色的功能開關(JSONB 存布林矩陣,或攤平成表)
CREATE TABLE roles (
  name        text PRIMARY KEY,          -- 'ADMIN' | 'USER' | 自訂
  permissions jsonb NOT NULL             -- { "AGENTS": {"USE":true,"CREATE":true,...}, ... }
);

-- 具名權限包(可選;也可硬編在程式常數,省一張表)
CREATE TABLE access_roles (
  access_role_id text PRIMARY KEY,        -- 'agent_viewer' | 'agent_editor' | 'agent_owner'
  resource_type  text NOT NULL,
  perm_bits      int  NOT NULL            -- 1 / 3 / 15
);

-- 第二層 ACL:一筆 = principal × resource × bits
CREATE TABLE acl_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal_type text NOT NULL,           -- 'user'|'group'|'role'|'public'
  principal_id   text,                    -- user/group 用 uuid 文字;role 用角色名;public 為 NULL
  resource_type  text NOT NULL,
  resource_id    uuid NOT NULL,
  perm_bits      int  NOT NULL CHECK (perm_bits BETWEEN 0 AND 15),
  role_id        text REFERENCES access_roles(access_role_id),
  granted_by     uuid,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  tenant_id      text NOT NULL
);

-- public 沒有 principal_id:用部分唯一索引 + 一般唯一索引兩段處理
CREATE UNIQUE INDEX acl_unique_principal
  ON acl_entries (principal_type, principal_id, resource_type, resource_id, tenant_id)
  WHERE principal_id IS NOT NULL;
CREATE UNIQUE INDEX acl_unique_public
  ON acl_entries (principal_type, resource_type, resource_id, tenant_id)
  WHERE principal_id IS NULL;

CREATE INDEX acl_lookup ON acl_entries (resource_type, resource_id, tenant_id);
CREATE INDEX acl_accessible ON acl_entries (principal_type, principal_id, resource_type, tenant_id);

-- 群組成員用關聯表取代 memberIds 字串陣列
CREATE TABLE group_members (
  group_id uuid NOT NULL,
  user_id  uuid NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
```

**有效權限查詢**變成一句 SQL,不需要超集列舉:

```sql
-- 使用者對某資源的有效位元 = 所有命中 principal 的 OR
SELECT COALESCE(bit_or(perm_bits), 0) AS bits
FROM acl_entries
WHERE tenant_id = $tenant
  AND resource_type = 'agent' AND resource_id = $rid
  AND (
    (principal_type='user'  AND principal_id = $uid)
    OR (principal_type='role'  AND principal_id = $role)
    OR (principal_type='public')
    OR (principal_type='group' AND principal_id IN (
         SELECT group_id::text FROM group_members WHERE user_id = $uid))
  );
-- 之後在應用層判斷 (bits & required) = required
```

「使用者可存取的所有 agent」列表用同一個 `WHERE` 子句 + `AND (perm_bits & 1) = 1` 直接查,取代 `findAccessibleResources`。

### Hono middleware:對應兩層

把兩層各做成一個 Hono middleware factory,和 LibreChat 一比一:

```ts
// 第一層:RBAC 功能開關,對應 generateCheckAccess
const requireFeature = (type: PermissionType, actions: Action[]) =>
  createMiddleware(async (c, next) => {
    const role = await getRole(c.get('user').role);   // 建議 Redis 快取
    const perms = role.permissions[type] ?? {};
    if (!actions.every((a) => perms[a] === true)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  });

// 第二層:資源 ACL,對應 canAccessResource
const requireResource = (type: ResourceType, bit: number, param = 'id',
                         resolve?: (id: string) => Promise<string | null>) =>
  createMiddleware(async (c, next) => {
    const user = c.get('user');
    if (await hasCapability(user, ResourceCapabilityMap[type])) return next(); // bypass
    const rid = resolve ? await resolve(c.req.param(param)) : c.req.param(param);
    if (!rid) return c.json({ error: 'Not Found' }, 404);
    const bits = await effectiveBits(user, type, rid);   // 上面那句 SQL
    if ((bits & bit) !== bit) return c.json({ error: 'Forbidden' }, 403);
    c.set('resourceAccess', { type, resourceId: rid, bits });
    await next();
  });

// 路由組合(對應 api/server/routes/agents/v1.js:108)
app.patch('/agents/:id',
  requireFeature('AGENTS', ['USE', 'CREATE']),
  requireResource('agent', PermBits.EDIT, 'id', resolveAgentId),
  updateAgentHandler);
```

Hono 的 `c.set/c.get` 天然取代 `req.resourceAccess` 掛載。`createMiddleware` 讓 factory 模式一致。

### Redis 的用途

- **角色權限快取**:`getRoleByName` 是每個第一層檢查都會打的查詢,角色很少變動,極適合 Redis 快取(key `role:{name}`,角色更新時失效)。LibreChat 的 `checkAccessWithRequestCache` 是 per-request 記憶體快取,你可以再往上加一層 Redis 做 cross-request。
- **使用者群組列表快取**:`getUserPrincipals` 每次都查群組,可快取 `principals:{userId}`(短 TTL 或群組變更時失效)。
- **有效權限快取(謹慎)**:可快取 `perm:{userId}:{resourceType}:{resourceId}`,但要在任何 ACL 變更時精準失效,否則會有「已撤銷仍可存取」的安全問題。建議 TTL 短(秒級)或乾脆不快取這層,只快取變動更慢的角色/群組。

### AI 框架的對應

權限系統與 AI 框架**基本正交**,四個候選(LangGraph、LangChain、deepagents、Vercel AI SDK)皆然——框架管的是 agent loop 本身(LangGraph 的 StateGraph、LangChain 的 `createAgent`、deepagents 的 `createDeepAgent`,或 ai-sdk 的 `streamText`/`Agent`;見 04-execution-engine.md、07-tool-system.md),不涉及授權。但兩個接點值得注意:

1. **工具過濾**:LibreChat 在 agent 初始化時用權限(如 MCP 的 `USE`)過濾可用工具(`filterAuthorizedTools`)。移植時,在把 `tools` 傳給執行入口之前(不論是 LangGraph 系框架的 `tools` 陣列/`bindTools`,還是 ai-sdk 的 `streamText`/`Agent` 的 `tools` 物件),先用第一層 RBAC + 第二層 ACL 篩掉使用者無權的工具/skill/MCP server。這一步發生在**組 tools 物件時**,四個框架都適用同一原則,不進框架內部。
2. **remote agent / API key 存取**:`REMOTE_AGENTS` 這類 endpoint 用 API key 認證後仍要過 ACL(`createCheckRemoteAgentAccess`)。若你把 agent 當成可被外部 API 呼叫的資源,授權中介層要放在 Hono route 上,執行框架(無論最終選哪一個)只負責執行,不涉及授權判斷。

### Next.js 前端考量

- **people picker**:對應 `GET /search-principals`,受第一層 `PEOPLE_PICKER` 的 `VIEW_USERS/VIEW_GROUPS/VIEW_ROLES` 三個子權限 gate(`checkPeoplePickerAccess.js`)。前端搜尋框要按使用者可搜的 principal 型別動態顯示分頁。
- **分享對話框**:前端拿 `AccessRoleIds`(viewer/editor/owner)給使用者選,不碰裸位元;送 `PUT /permissions/:type/:id` 帶 `{ updated, removed, public, publicAccessRoleId }`(`updateResourcePermissionsRequestSchema`)。`public` 開關要在前端就依角色的 `SHARE_PUBLIC` 能力決定是否可點。
- **有效權限驅動 UI**:用 `permBitsToAccessLevel` 把後端回的 bits 折成 `viewer/editor/owner` 顯示;`GET /:type/effective/all` 一次拿一整批資源的權限 map,避免每張卡片各打一次 API。
- **市集**:`is_promoted` + `category` 做探索頁,但務必記得「可見於市集 ≠ 可用」,實際使用仍走 ACL,前端不要假設市集列表都能開。

### 移植檢查清單

- 兩層都要實作且**兩層都要過**(AND 語意),別把 RBAC 和 ACL 合成一層。
- owner 用 ACL entry 表示,建立資源時同 transaction 寫入 owner ACL。
- 有效權限用 `bit_or` 的 OR 疊加,PostgreSQL 直接位元運算,砍掉 Cosmos 超集列舉。
- 四種 principal(user/group/role/public)都要支援;role 讓「分享給整個角色」可行,public 用 NULL principal_id + 部分唯一索引。
- capability/admin bypass 若要保留,集中成單一 `authorize()` 並 fail-closed。
- 多租戶隔離用顯式 `tenant_id` 參數,不要學 LibreChat 的隱式 ALS context。
