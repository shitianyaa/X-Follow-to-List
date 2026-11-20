<p align="center">
  <img src="extension-dist/icons/icon128.png" alt="X Follow to List" width="96">
</p>

<h1 align="center">X Follow to List</h1>

<p align="center">
  <strong>Import a custom account list or filter your Following, then bulk add selected accounts to an X/Twitter List</strong><br>
  Free local extension for Chrome, Edge, and other Chromium browsers. No API key, no server.
</p>

## Usage Demo / 使用演示

### 1. Get your following list / 获取关注列表

<p align="center">
  <img src="assets/demo/capture-following.gif" alt="Get your following list" width="680">
</p>

### 2. Filter accounts / 筛选账号

<p align="center">
  <img src="assets/demo/filter-accounts.gif" alt="Filter accounts" width="360">
</p>

### 3. Add accounts to your list / 添加到列表

<p align="center">
  <img src="assets/demo/add-to-list.gif" alt="Add accounts to your list" width="680">
</p>

## Install / 安装

> [!IMPORTANT]
> This extension is distributed through GitHub and must be installed in Developer mode. The ZIP cannot be installed directly.

### Download the ready-to-use package / 下载成品包

1. [Download the ZIP from the latest GitHub Release](https://github.com/DrErwin/X-Follow-to-List/releases/latest/download/X-follow-to-list.zip). The SHA-256 checksum is available in the [same release](https://github.com/DrErwin/X-Follow-to-List/releases/latest/download/SHA256SUMS.txt).
2. Extract the ZIP to a permanent folder. Do not delete that folder after installation.
3. Open your browser's extension page:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
   - Brave: `brave://extensions/`
4. Enable **Developer mode / 开发人员模式**.
5. Click **Load unpacked / 加载已解压的扩展程序**.
6. Select the extracted folder containing `manifest.json`.

To install from source, clone this repository and select the [`extension-dist`](extension-dist) folder instead.

## Features / 功能

- Capture accounts loaded while scrolling your X Following page / 滚动 Following 页面时捕获已加载账号
- Paste a custom account list or import TXT/CSV, including accounts you do not follow / 粘贴自定义名单或导入 TXT/CSV，无需先关注名单中的账号
- Filter by keywords, profile counts, location, mutual follows, and more / 按关键词、账号数据、位置、互关等条件筛选
- Select accounts individually, select all, invert selection, or export CSV / 单选、全选、反选或导出 CSV
- Add selected accounts to a specified X List with configurable intervals / 按可配置间隔将所选账号加入指定 List
- Pause, resume, retry, view history, and export or import task snapshots / 暂停、继续、重试、历史记录及任务快照
- Store account data, settings, and task state locally in the browser / 数据、设置及任务状态仅保存在浏览器本地

## How to Use / 使用方法

### Custom account list / 自定义名单

1. Sign in to X. After loading or refreshing the X page, open any account's profile and wait for its details to load. The extension learns the current account-lookup request from that page; no API key is needed. / 登录 X；每次加载或刷新 X 页面后，先打开任意账号的个人主页，等待资料加载，以连接当前账号查询接口。
2. Click the extension icon. Under **自定义名单**, paste usernames, `@usernames`, or X/Twitter profile links. Separate entries with English/Chinese commas, newlines, spaces, or semicolons. Alternatively, click **导入 TXT / CSV**. / 点击扩展图标，在“自定义名单”中粘贴账号，或导入 TXT / CSV。

   ```text
   @alice, bob, https://x.com/carol
   https://twitter.com/dave
   ```

3. Expand **自定义名单** and click **解析名单**. Accounts are resolved one at a time using the configured intervals and batch pauses. Invalid entries and unavailable accounts are reported. Cached accounts appear immediately without another lookup by default. To refresh cached accounts with missing statistics, enable **补全缓存中的未知统计** before parsing; each incomplete account gets at most one lookup per run, while accounts with complete statistics are reused. / 展开“自定义名单”并点击“解析名单”；按现有间隔和批次设置逐个查询，自动去重并显示失败项。缓存账号默认直接复用；需要补全未知统计时，先勾选对应选项再解析，每个缺失账号每轮只补查一次，统计完整的账号不重复查询。
4. Review and select the results directly in the same section. The target List link and import button remain at the bottom of the panel. / 解析后直接查看同一分区内的结果并勾选；目标 List 链接和导入按钮固定在面板底部。

CSV files may contain a `handle`, `screen_name`, `username`, `profile_url`, or `url` column. CSV files exported by this extension can be imported again. Files are limited to 1 MB and local account storage to 5,000 accounts. / CSV 支持上述账号列，也支持重新导入本扩展导出的账号 CSV；文件上限 1 MB，本地最多收录 5,000 个账号。

If X rejects or rate-limits account lookups, parsing stops and saves the cooldown locally. Respecting `Retry-After` when present, it uses the existing cooldown durations and blocks new parsing and List imports until that cooldown ends. Successful accounts remain available; parsing the same list again skips them. The existing List-import retry, pause, resume, and cooldown behavior is retained. / 查询触发限流或验证时会停止，并沿用现有冷却时长；冷却期间禁止继续解析或启动列表导入。成功解析的账号会保留，再次解析同一名单可跳过它们。原有列表导入的重试、暂停、恢复和冷却逻辑保留。

### Following page / 关注列表

1. Sign in to X and open your Following page, such as `https://x.com/yourname/following`.
2. Scroll down to load the accounts you want to manage.
3. Click the extension icon, set filters, and choose accounts.
4. Open the target X List and copy its share link into the extension.
5. Confirm the target and start the task. Begin with a small batch and conservative intervals.

### Sources, statistics and cache / 来源、统计与缓存

- **自定义名单** and **关注列表** are separate collapsible sections. Each has its own account membership; both reuse one local profile cache. Filters apply to the current section. Selected account IDs are shared and deduplicated before import. / 两个来源分开展示并分别计数，共用账号资料缓存；筛选针对当前分区，同一账号跨分区选中也只加入队列一次。
- Each new custom parse replaces the previous custom membership. **清空自定义名单** or **清空关注列表** removes that section's membership while keeping profile data available for reuse. Accounts selected only in the cleared section are deselected. / 每次解析会更新当前自定义名单；“清空名单”保留资料缓存，只取消没有其他来源归属的账号勾选。
- **清除缓存** removes all local account profiles, source memberships and selections. It leaves X List members, the active job, history and cooldown deadlines intact. Clearing a source or cache requires confirmation. / “清除缓存”清除全部账号资料、来源名单和勾选，不删除 X List 成员，也不重置当前任务、历史记录或冷却。
- The cache survives page reloads, has no automatic expiry and holds at most 5,000 profiles. Clearing a source does not free cache capacity; use **清除缓存** to reset the shared cache. Old mixed accounts without source information are retained under **历史缓存**, then classified when captured or supplied in a custom list again. / 缓存刷新后保留，不自动过期，最多保存 5,000 个账号；清空名单不释放缓存容量。旧版混合数据保留在“历史缓存”，重新捕获或导入时补充来源。
- Current and legacy X profile-count fields are supported. Missing statistics display **未知**, rather than zero, and do not match numeric filters for that statistic. Ambiguous old-cache zeros also become unknown. Duplicate records within a response fill missing counts; later partial responses preserve known counts. Normal profile visits update existing cached accounts without extra requests or changing their source membership. To repair remaining unknown counts, paste the accounts into the custom section and enable **补全缓存中的未知统计** before parsing. This optional lookup uses the same intervals and cooldowns, without clearing the cache. If X still omits a statistic, it remains unknown. / 兼容新旧统计字段，缺失数据和旧缓存中不确定的零值显示“未知”，不参与对应数值筛选。同一响应的重复资料会补齐缺失统计，后续简略响应保留已知值。正常浏览个人主页时，会用网页现有响应更新已缓存账号，不额外发请求、不改变来源。仍有未知统计时，可将账号粘贴到自定义名单，勾选补全选项再解析，沿用间隔和冷却，无需清缓存；X 未返回的统计仍显示未知。

## Privacy and Safety / 隐私与安全

- No developer-operated server, analytics, advertising, or telemetry.
- No X API key is required; actions use your current X web session.
- Raw authorization and CSRF values are not stored or exported.
- Bulk activity may trigger X rate limits or temporary restrictions. Use small batches and follow X's current rules.
- Export a task snapshot before clearing browser data or uninstalling the extension.
- Never include passwords, cookies, authorization headers, or session tokens in a public Issue.

See the full [Privacy Policy / 隐私政策](PRIVACY.md).

## Updating / 更新

1. Download and extract the new package.
2. Export a task snapshot, then replace the files inside the folder you originally loaded.
3. Click **Reload / 重新加载** on the extension card.

Loading the update from a different folder may create a different unpacked extension ID and separate local storage, so updating the original folder is recommended.

## Local checks / 本地验证

Run the dependency-free regression tests with Node.js: / 使用 Node.js 运行无需安装依赖的回归测试：

```sh
node --test tests/account-import.test.cjs tests/account-state.test.cjs
```

## Feedback / 反馈

Found a problem? [Open an Issue](https://github.com/DrErwin/X-Follow-to-List/issues/new/choose) and include your browser version, extension version, page URL type, and reproduction steps. Do not include private session information.

X Follow to List is an independent, unofficial tool and is not affiliated with, authorized by, or endorsed by X Corp.

If it helps, a GitHub Star is appreciated.
