# 远程项目预览

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

1. 在 A 暂停自动发布。迁移订阅组服务时，复制 `/srv/mekir-previews/`、`/etc/mekir-preview/groups.json` 和私有的 `/etc/mekir-preview/users`，保留订阅库 ID 和项目 ID。在新主机恢复相同权限，配置新 HTTPS 地址，按下节步骤重新生成权限配置。
2. B 在「订阅组 → 账号设置」填写新根地址和此地址的密码。确认新服务的订阅库 ID 后，mekiR 会把现有副本连接到新地址。按单个项目地址订阅的设备可在该项目的「订阅设置」更换项目地址。
3. A 在「发布远程预览」中换到新项目地址并恢复自动发布。用 B 拉取一次并核对最新进展，再退役旧服务。

可使用支持 HTTPS、GET、HEAD、PUT、MKCOL、MOVE 和 DELETE 的 WebDAV。地址指向项目专用目录，上级目录应已存在。反向代理须允许 WebDAV 方法，并保留 MOVE 的 Destination 和条件请求头。客户端仅在本机回环地址允许明文 HTTP。

## 自建私有服务

仓库的 [Apache 配置和 systemd 单元](../deploy/remote-preview/) 适用于 Debian 或 Ubuntu。样例采用 Tailscale Serve 终止 HTTPS，Apache 只监听回环地址。使用其他 HTTPS 反向代理时，在 `endpoint` 填对外地址即可。以下命令在服务器上运行，当前目录为仓库根目录。

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

把 `your-node.your-tailnet.ts.net` 换成服务器的实际 Tailscale DNS 名称。读者填 `https://your-node.your-tailnet.ts.net:9443/`，发布者填具体项目路径，例如 `https://your-node.your-tailnet.ts.net:9443/render-research/`。

### 管理组与项目

在 `users` 中用 `htpasswd -B` 添加账号。在 `groups.json` 的 `projects` 中登记项目的稳定 `id`、展示名称 `title`、服务器子目录 `directory` 和发布账号列表 `publishers`。每个组的 `members` 填用户名，`projects` 填项目 ID。一个账号可加入多个组，项目也可加入多个组。读权限取所有组的并集，写权限按项目的 `publishers` 单独指定。

每次修改成员、项目或密码文件中的账号后，在服务器执行以下命令。编译器会校验账号引用和已发布的项目 ID，为新登记的项目建立目录，并生成每个账号的清单与相应的 WebDAV 读写规则。Apache 同时对项目原始地址和账号清单执行授权。

```sh
python3 /etc/mekir-preview/groups.py &&
  (set -a; . /etc/mekir-preview/endpoint; /usr/sbin/apache2 -t -f /etc/mekir-preview/httpd.conf) &&
  systemctl reload mekir-preview
```

组变更在客户端下次连上服务器检查清单时生效。项目移出一个组后，只要另一个已加入的组仍包含它，就能继续阅读。失去最后一个组的权限，或服务器拒绝该账号后，客户端会从项目列表移除相应项目并清理本机副本。离线设备将在重新联网检查时收到变更。

每天的清理任务保留当前版、上一版和两版引用的图片。其他快照、缩略图和未完成的上传至少保留 24 小时，避免打断正在阅读或上传的设备。接入其他 WebDAV 时，可在其存储主机使用同一个 `prune.py <数据根目录>` 执行清理。
