# 远程项目预览

管理员在独立的网页后台维护账号、项目和订阅组。组内成员用桌面端选择要拉取的项目。

电脑 A 在「项目设置 → 发布远程预览」里填写 WebDAV **项目目录**和发布账号，选择「保存并发布」。管理员将项目加入订阅组后，组内成员即可在自己的设备上发现它。

电脑 B 打开「切换科研项目 → 订阅组」，用**订阅服务器根地址**和自己的账号登录。登录和「刷新清单」只读取组名和项目列表。可以按组筛选，跨组勾选想看的项目，然后点「拉取所选项目」。拉取范围是整个项目已发布的快照和缩略图。项目属于多个组时，同一个账号在本机共用一份副本。

拉取后，在组内点「打开」，或从项目切换器进入「远程订阅 · 只读」。在同一套工作区里可以缩放时间线、选阶段、搜索共享记录、沿链接阅读正文，也可以并排或滑动查看对比图。断网后可以继续读本机副本。工具栏的刷新按钮会拉取当前项目的新快照。在组内打开项目旁的「本机副本设置」，可开启「阅读时自动更新」，或移除本机副本并保留组成员资格。

已通过项目地址订阅过的用户可以在首次登录时选择「使用本机已保存的项目账号」。已经下载并登记到组里的项目会沿用原有副本。普通 WebDAV 也可以从「按项目地址订阅」进入单个项目，填写该项目目录和凭据。

A 上的 mekiR 运行期间，每 15 秒检查已启用发布的项目，覆盖外部 agent 直接写入的记录和绑定的对比图。切换到其他项目也会继续检查。上次发布失败会保留可用版本并重试。退出应用后，下次启动会补上变更。「暂停自动发布」可随时停用。手动「保存并发布」会立即检查服务器。

## 发布范围

时间线保留各阶段时段、每天的实验活动与追加试次。阶段页显示研究问题、目标、最近结论、总结摘录和项目事件。图像对比保留行列标签、图注和重新编码的缩略图。勾选精选记录才会发布该记录的完整正文，最多 24 篇，每篇 96 KiB。精选正文保留标题、列表和表格，指向已分享记录的 `mekir:` 链接可在阅读侧栏打开。外部链接和嵌图以静态内容展示。发布器不会上传索引、来源目录、原始图片或附件。

## 数据和服务迁移

一个项目占一个目录。服务器只存文件，目录内的引用都与主机名无关。

```text
project/
  latest.json
  snapshots/<sha256>.json
  media/<sha256>.jpg 或 .png
```

发布器先上传内容，再用 WebDAV MOVE 切换 `latest.json`。订阅端核对项目 ID、快照和图片的 SHA-256，在下载完成后替换本地缓存。一个目录由一台 A 发布，可供多台 B 订阅。

1. 在 A 暂停自动发布。复制 `/srv/mekir-previews/`。启用后台后，用 `readlink -f /var/lib/mekir-preview-admin/current` 取得当前版本目录，从**同一目录**备份 `groups.json` 和 `users`，另存 `/etc/mekir-preview/admin-users`。在新主机把组清单和订阅账号文件恢复到 `/etc/mekir-preview/`，把管理员文件恢复为 `root:mekir-preview`、模式 `0640`。启动基础服务后安装下方后台，已有账号、组和项目 ID 即可继续使用。仅使用命令行的旧服务直接从 `/etc/mekir-preview/` 备份组清单与账号文件。
2. B 在「订阅组 → 账号设置」填写新根地址和此地址的密码。确认新服务的订阅库 ID 后，mekiR 会把现有副本连接到新地址。按单个项目地址订阅的设备可在该项目的「订阅设置」更换项目地址。
3. A 在「发布远程预览」中换到新项目地址并恢复自动发布。用 B 拉取一次并核对最新进展，再退役旧服务。

可使用支持 HTTPS、GET、HEAD、PUT、MKCOL、MOVE 和 DELETE 的 WebDAV。地址指向项目专用目录，上级目录应已存在。反向代理须允许 WebDAV 方法，并保留 MOVE 的 Destination 和条件请求头。客户端仅在本机回环地址允许明文 HTTP。

## 自建私有服务

仓库的 [Apache 配置和 systemd 单元](../deploy/remote-preview/) 适用于 Debian 或 Ubuntu。样例采用 Tailscale Serve 终止 HTTPS，Apache 只监听回环地址。使用其他 HTTPS 反向代理时，在 `endpoint` 填对外地址即可。以下命令在服务器上运行，当前目录为仓库根目录。迁移已有服务时，保留恢复的 `users` 和 `groups.json`，跳过创建示例账号和复制示例清单的步骤。

```sh
apt-get install --no-install-recommends apache2-bin apache2-utils python3
getent passwd mekir-preview >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin mekir-preview
install -d -m 750 -o root -g mekir-preview /etc/mekir-preview
install -d -m 700 -o mekir-preview -g mekir-preview /srv/mekir-previews
install -m 644 deploy/remote-preview/httpd.conf deploy/remote-preview/groups.py deploy/remote-preview/prune.py /etc/mekir-preview/
install -m 644 deploy/remote-preview/*.service deploy/remote-preview/*.timer /etc/systemd/system/
touch /etc/mekir-preview/users
chown root:mekir-preview /etc/mekir-preview/users
chmod 640 /etc/mekir-preview/users
htpasswd -B /etc/mekir-preview/users publisher
htpasswd -B /etc/mekir-preview/users reader
printf '%s\n' 'MEKIR_PREVIEW_ORIGIN=https://your-node.your-tailnet.ts.net:9443' > /etc/mekir-preview/endpoint
# 首次安装时，以样例建立组和项目清单，按实际成员和项目 ID 编辑。
install -m 640 -o root -g mekir-preview deploy/remote-preview/groups.example.json /etc/mekir-preview/groups.json
python3 /etc/mekir-preview/groups.py
systemctl daemon-reload
systemctl enable --now mekir-preview.service mekir-preview-prune.timer
tailscale serve --bg --https=9443 http://127.0.0.1:17841
```

把 `your-node.your-tailnet.ts.net` 换成服务器的实际 Tailscale DNS 名称。读者可以从管理后台的组详情复制「订阅服务器地址」，也可以直接填服务器的 Tailscale IP 和订阅端口，例如 `100.70.1.8:9443`。两种写法都使用 HTTPS。使用 IP 连接 Tailscale Serve 时，mekiR 从本机 Tailscale 客户端核对设备名，用它验证证书，并始终连接所填的 IP。IPv6 带端口时写作 `[fd7a:115c:a1e0::1]:9443`。

订阅组登录使用服务器根地址。单个项目的订阅或发布使用带目录的地址，例如 `100.70.1.8:9443/render-research/`，也可以从管理后台的项目详情复制。普通 HTTPS 服务器支持通过证书覆盖的 IP 直接连接。

### 安装网页管理后台

在运行预览服务的 Linux 主机上执行以下命令。后台共用现有 Apache，管理请求通过 CGI 调用 Python 标准库。安装器首次从现有组清单和订阅账号文件导入数据，并重启一次预览服务。再次运行安装器会沿用当前数据。日常增删成员、登记项目和重置密码在保存时生效。

```sh
umask 077
admin_accounts=$(mktemp)
htpasswd -B "$admin_accounts" admin
python3 deploy/remote-preview/install-admin.py \
  --origin https://your-node.your-tailnet.ts.net:9444 --admin-users "$admin_accounts"
rm "$admin_accounts"
tailscale serve --bg --https=9444 http://127.0.0.1:17842
```

迁移时如果已恢复 `admin-users`，直接执行安装器并省略 `--admin-users` 即可。替换实际的 Tailscale 主机名后，在浏览器打开配置的管理网址，用独立管理员账号登录。订阅端继续连接原来的 `9443`。使用其他反向代理时，将管理域名或独立 HTTPS 端口指向 `127.0.0.1:17842`，同步调整 `--origin`。管理员和发布者上传的文档位于两个浏览器来源，即使发布内容包含网页，浏览器也会隔离它和管理页面。

**账号**页可以创建账号、重置密码、调整加入的组，或移除账号及其发布授权。**项目**页可以登记发布端的项目 ID 和目录、复制 WebDAV 发布地址、选择所属组及可写入的发布账号。取消登记会保留项目快照。**订阅组**页可以创建组、改名，或同时调整组内的项目和成员。项目的阅读权限取各组并集，写入权限由该项目的可发布账号名单决定。

后台把账号、成员关系、项目清单和 WebDAV 权限写入同一版本，再一次切换生效。两个管理员同时编辑时，较早打开的表单会提示刷新核对。磁盘保留当前和上一个管理版本。项目快照继续遵循原有保留计划。添加或重置后台管理员时，在主机运行 `htpasswd -B /etc/mekir-preview/admin-users 用户名`，保留文件原有权限。

**管理接口**与网页使用相同的管理员认证。`GET /api` 返回可管理的账号名、组、项目和 `revision`。`POST /api` 提交 `revision`、`action` 和 `data`，使用 `Content-Type: application/json`、管理网址的 `Origin` 和 `X-MekiR-Request: admin`。`action` 包括 `group`、`project`、`account` 的 `create`、`update`、`remove`。版本过期返回 HTTP 409。发布账号和订阅读者使用各自原有的接口。

### 仅使用文件管理的部署

未安装后台时，可以用 `htpasswd -B /etc/mekir-preview/users 用户名` 维护订阅账号，并在 `groups.json` 中编辑 `projects`、每个组的 `members` 和项目 ID 列表。修改后执行以下命令。

```sh
python3 /etc/mekir-preview/groups.py &&
  (set -a; . /etc/mekir-preview/endpoint; /usr/sbin/apache2 -t -f /etc/mekir-preview/httpd.conf) &&
  systemctl reload mekir-preview
```

客户端在下次刷新清单时收到组变更。项目移出一个组后，只要另一个已加入的组仍包含它，就可以继续阅读。设备重新联网并确认失去最后一项组权限时，会清理对应副本。

每天的清理任务保留当前版、上一版和两版引用的图片。其他快照、缩略图和未完成的上传至少保留 24 小时，避免打断正在阅读或上传的设备。接入其他 WebDAV 时，可在其存储主机使用同一个 `prune.py <数据根目录>` 执行清理。
