# 远程项目预览

在电脑 A 的「项目设置 → 发布远程预览」中填写 WebDAV **项目目录**和发布账号，选择「保存并发布」。在电脑 B 的项目切换器里选择「订阅远程项目」，填写同一个目录和只读账号。订阅成功后，项目会出现在同一份项目列表中，标为「远程订阅 · 只读」。点开会直接进入项目工作区。可以缩放时间线、选择阶段、搜索共享记录、在正文侧栏顺着链接阅读，也可以并排或滑动查看对比图。关闭正文会回到原来的筛选和滚动位置。

重新启动会打开上次选中的订阅，先显示本机缓存。浏览期间每分钟检查更新，也可以点工具栏的刷新按钮。断网时仍可阅读已下载的正文和对比缩略图。

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

1. 在 A 暂停自动发布，把整个项目目录复制到新 WebDAV。复制时保留文件名。两端的账号可以不同。
2. 在 B 打开原有订阅，进入右上角「订阅设置」，填入新地址和新凭据。mekiR 会核对项目 ID，保留订阅和缓存。也可以先在一台设备上试读。
3. 在 A 的「发布远程预览」里换到新地址，勾选自动发布并保存。确认 B 收到了下次变更后，再退役旧服务。

可使用支持 HTTPS、GET、HEAD、PUT、MKCOL、MOVE 和 DELETE 的 WebDAV。地址指向项目专用目录，上级目录应已存在。反向代理须允许 WebDAV 方法，并保留 MOVE 的 Destination 和条件请求头。客户端仅在本机回环地址允许明文 HTTP。

## 自建私有服务

仓库的 [Apache 配置和 systemd 单元](../deploy/remote-preview/) 适用于 Debian 或 Ubuntu。样例采用 Tailscale Serve 终止 HTTPS，Apache 只监听回环地址。使用其他 HTTPS 反向代理时，在 `endpoint` 填对外地址即可。以下命令在服务器上运行，当前目录为仓库根目录。

```sh
apt-get install --no-install-recommends apache2-bin apache2-utils python3
getent passwd mekir-preview >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin mekir-preview
install -d -m 750 -o root -g mekir-preview /etc/mekir-preview
install -d -m 700 -o mekir-preview -g mekir-preview /srv/mekir-previews
install -m 644 deploy/remote-preview/httpd.conf deploy/remote-preview/prune.py /etc/mekir-preview/
install -m 644 deploy/remote-preview/*.service deploy/remote-preview/*.timer /etc/systemd/system/
touch /etc/mekir-preview/users
chown root:mekir-preview /etc/mekir-preview/users
chmod 640 /etc/mekir-preview/users
htpasswd -B /etc/mekir-preview/users publisher
htpasswd -B /etc/mekir-preview/users reader
printf '%s\n' 'MEKIR_PREVIEW_ORIGIN=https://your-node.your-tailnet.ts.net:9443' > /etc/mekir-preview/endpoint
systemctl daemon-reload
systemctl enable --now mekir-preview.service mekir-preview-prune.timer
tailscale serve --bg --https=9443 http://127.0.0.1:17841
```

把 `your-node.your-tailnet.ts.net` 换成服务器的实际 Tailscale DNS 名称。客户端地址可以是 `https://your-node.your-tailnet.ts.net:9443/project-name/`。此配置的读者可查看该服务内的项目，发布账号可写。用于不同访问群组时，可分别配置目录的 Apache 授权规则。迁移整项服务时，备份 `/srv/mekir-previews` 和私有的 `/etc/mekir-preview/users`，在目的机器恢复同样的权限，再设置新地址及 HTTPS。

每天的清理任务保留当前版、上一版和两版引用的图片。其他快照、缩略图和未完成的上传至少保留 24 小时，避免打断正在阅读或上传的设备。接入其他 WebDAV 时，可在其存储主机使用同一个 `prune.py <数据根目录>` 执行清理。
