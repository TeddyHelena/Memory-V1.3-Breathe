# 安装 MemoryV1.3-Breathe（预览版）

> 适用：DSH 桌面端 0.2.2+，macOS。安装会改动 DSH profile，装前必须备份。

## 0. 准备

```bash
# 确认 DSH 已完全退出（Cmd+Q），不是只关窗口
PROFILE="$HOME/.dsh/profiles/desktop"
CONTAINER="$HOME/Documents/Obsidian Vault/00_记忆系统/dsh-memory-container"
```

## 1. 验包

```bash
shasum -a 256 MemoryV1.3-Breathe-1120.4.zip
cat MemoryV1.3-Breathe-1120.4.zip.sha256   # 两值必须一致
unzip -q MemoryV1.3-Breathe-1120.4.zip -d /tmp/breathe-install
ls /tmp/breathe-install   # 应见 lib/ src/ package.json
```

## 2. 备份（不许跳）

```bash
TS=$(date +%Y%m%d-%H%M%S); mkdir -p ~/.dsh/backups
cp -p "$PROFILE/package.json" ~/.dsh/backups/package.json.$TS
cp -p "$PROFILE/cordis.patch.yml" ~/.dsh/backups/cordis.patch.yml.$TS
tar -czf ~/.dsh/backups/memory-container.$TS.tgz -C "$(dirname "$CONTAINER")" "$(basename "$CONTAINER")"
readlink "$PROFILE/node_modules/dsh-memory-container" > ~/.dsh/backups/memory-target.$TS
```

## 3. 落位

```bash
DEST="$HOME/.dsh/plugins/dsh-memory-container-breathe"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R /tmp/breathe-install/dsh-memory-breathe "$DEST"
```

## 4. 切换 profile

```bash
# package.json：把 dsh-memory-container 的依赖值改成 link:<DEST>
# 或用编辑器改，或：
python3 - "$PROFILE/package.json" "$DEST" <<'PY'
import json,sys
p,d=sys.argv[1],sys.argv[2]
j=json.load(open(p)); j["dependencies"]["dsh-memory-container"]="link:"+d
open(p,"w").write(json.dumps(j,ensure_ascii=False,indent=2)+"\n")
PY
ln -sfn "../../../.dsh/plugins/dsh-memory-container-breathe" "$PROFILE/node_modules/dsh-memory-container"
```

> 软链目标请用绝对路径或确认相对路径正确；切换后 `readlink` 应指向 `$DEST`。

## 5. 重启并验收

1. 重新打开 DSH。
2. 左侧「记忆」入口可打开，三个视图（列表 / 知识球 / 关系图）正常。
3. 新建一条链、删掉，条目数不变。
4. `curl -s -o /dev/null -w '%{http_code}' -H "x-memory-token: $(cat ~/.dsh/memory-api-token)" http://127.0.0.1:<port>/api/memory/list` 返回 200。

## 6. 回滚

```bash
TS=<安装时的 TS>
cp -p ~/.dsh/backups/package.json.$TS "$PROFILE/package.json"
ln -sfn "$(cat ~/.dsh/backups/memory-target.$TS)" "$PROFILE/node_modules/dsh-memory-container"
# 容器若被升级污染，再恢复：
# tar -xzf ~/.dsh/backups/memory-container.$TS.tgz -C "$(dirname "$CONTAINER")"
```

回滚后 Cmd+Q 重启。恢复旧容器会丢掉安装后新增的记忆，执行前确认。
