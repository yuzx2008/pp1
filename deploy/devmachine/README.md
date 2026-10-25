# pp1 跑在 comp2 开发机上

把 asr / tts / chat / brain 从 comp2 的 k8s 挪进一台 zmlp 开发机，用两张 4090 整卡。
`deploy/k8s/` 原样保留，随时可以切回去。

## 为什么不用 time-slicing

k8s 里 2 张卡被 device plugin 切成 4 个 `nvidia.com/gpu` 单元，asr×2 + tts + chat 正好占满。
开发机是整卡申请（`ml.g4090.4xlarge` = 2 卡），不需要切分，也就不存在"和邻居抢显存"。

| 卡 | 服务 | 显存预算 |
|---|---|---|
| GPU0 | asr + tts（`CUDA_VISIBLE_DEVICES=0`） | 5 + 13.7 GB |
| GPU1 | chat（`CUDA_VISIBLE_DEVICES=1`） | 27 GB（`--gpu-memory-utilization=0.90`） |

## 从零到跑起来

### 1. 准备项目卷目录

平台不会自动建 subpath：`pp1` 不存在时，开发机会卡在 `FailedMount`。
先找一台已挂载该项目卷根目录的开发机，在里面建：

```bash
mkdir -p /<项目卷挂载根>/pp1/{asr,tts,chat,voices,pp1/logs,pp1/run,pp1/secrets}
```

### 2. 放权重（34 GB，放项目卷，不塞系统盘）

在 **comp2（有 kubectl 的那台）** 上执行，右边直接写进开发机，不落中间文件：

```bash
ssh <machine> 'mkdir -p /models/{asr,tts,chat,voices}'
kubectl -n pp1 exec deploy/asr  -- tar -C /models/asr  -cf - . | ssh <machine> 'tar -C /models/asr  -xf -'
kubectl -n pp1 exec deploy/tts  -- tar -C /models/tts  -cf - . | ssh <machine> 'tar -C /models/tts  -xf -'
kubectl -n pp1 exec deploy/chat -- tar -C /models      -cf - . | ssh <machine> 'tar -C /models/chat -xf -'
kubectl -n pp1 exec deploy/tts  -- tar -C /voices      -cf - . | ssh <machine> 'tar -C /models/voices -xf -'
```

chat 那 22 GB 最慢，可以最后再拷。拷完用 `du -sh` 对一下大小。

### 3. 建开发机

先把 `machine.yaml` 里四个 `REPLACE_ME` 换成真实值（镜像 digest、队列、项目卷 ID），然后：

```bash
mlp machine create -f machine.yaml --dry-run -o yaml   # 本地严格校验
mlp machine create -f machine.yaml --apply --wait --for Running --wait-timeout 10m
```

`mlp machine get <id>` 会给出 `SSH COMMAND`，照抄即可登录。

### 4. 准备 token 文件

先把脚本目录拷进开发机（开发机重启后 rootfs 还在，只需拷一次）：

```bash
scp -r deploy/devmachine <machine>:~/pp1-dev
```

```bash
mkdir -p /models/pp1/secrets
openssl rand -hex 24 > /models/pp1/secrets/brain-token
chmod 600 /models/pp1/secrets/brain-token
```

手机 App 和 codex 桥要填同一个值。脚本启动时从文件读，仓库里不出现明文。

### 5. 起服务

```bash
cd <仓库>/deploy/devmachine
./pp1-up.sh --dry-run     # 先看要跑什么（token 显示为 ***）
./pp1-up.sh
./pp1-status.sh
```

首次启动要等 asr 预热（约 1 分钟）、tts 加载两个常驻 daemon（更久）、chat 加载 22 GB 权重（最久）。
脚本按 `PP1_*_TIMEOUT` 等 `/health`，超时会打印该服务最后 30 行日志（已脱敏）。

### 6. 暴露端口

四个端口都在开发机本机监听。要让集群外访问（手机、k8s 里的 brain）：

```bash
mlp machine endpoint create <machine-id> --target-port 8787   # 每个端口一条
mlp machine port enable <machine-id> --port <端口>
```

同一个集群内的 brain 优先走开发机的集群内地址，别绕公网。

## 重启后恢复

开发机没有 systemd / supervisor，容器是 `RestartPolicyNever`。**机器 stop/start、节点驱逐、
Pod 重建后，服务不会自己回来**，这是唯一的恢复方式：

```bash
ssh <machine> 'cd ~/pp1-dev && ./pp1-up.sh'
```

脚本是幂等的：已经在跑且健康的服务会跳过。端口映射在机器停机后会被撤，重新 `port enable`。

## 回滚到 k8s

1. 开发机上 `./pp1-down.sh`
2. 开发机 `mlp machine stop <id> --apply`（释放卡时）
3. 把 `deploy/k8s/` 按原顺序 apply 回去；weight PVC 没动过，不需要重新下载
4. 手机 / 桥的地址改回 ingress 域名

## 常用操作

```bash
./pp1-status.sh          # 进程 / 端口 / 健康 / 显存
./pp1-down.sh            # 全停
./pp1-down.sh --keep-chat  # 只停 asr/tts/brain，chat 不重载
./pp1-up.sh --only tts   # 只拉起一个
tail -f /models/pp1/logs/asr.log
```

## 已知限制

- 单机单点：没有副本，asr 重启期间转写会失败（k8s 里用 2 副本规避了这一点）。
- 开发机没有自启；看门狗需要在集群外做（定时 SSH 执行 `pp1-up.sh`，或接平台事件）。
- `nvidia-smi` 看到的显存是整卡口径，`PP1_ASR_TTS_GPU` / `PP1_CHAT_GPU` 写反了不会报错，
  只会把两个服务挤到一张卡上——`pp1-status.sh` 的显存列能看出来。

## 实际落地记录（2026-10-22）

- 平台：zmlp / comp2 context，队列 `REPLACE-ME-QUEUE-ID`
- 开发机：`REPLACE-ME-MACHINE-ID`（`ml.g4090.2xlarge` = 1×4090 48GB，rootfs 20Gi）
- 镜像：合并镜像 artifact `REPLACE-ME-ARTIFACT-ID`（asr + tts 同一镜像，含 sshd/agent 入口）
- 存储：项目卷 `REPLACE-ME-VOLUME-ID`（已扩到 60GiB），挂到 `/models`
- 服务：asr 8082、tts 8080（两个 moss daemon 懒加载），用 `/opt/pp1/pp1-asr-tts-start.sh all` 起
- 入口：平台 endpoint `asr`/`tts` → ClusterIP Service `devmachine-REPLACE-ME-MACHINE-ID.devmachine.svc.cluster.local`
- brain 留在 k8s（`pp1` ns），`STT/TTS_API_BASE_URL` 指向上面的 Service；chat 仍在 k8s 占另一张整卡
- GPU：节点已关闭 time-slicing（device plugin replicas=0，allocatable=2）
- **网络策略**：`devmachine` ns 的 `ml-platform-devmachine-ingress` 追加了一条允许 `pp1` namespace 访问 8082/8080/8000/8787 的规则（平台 reconcile 可能覆盖，覆盖后 brain 会连不上开发机）
- **重启恢复**：开发机重启后 SSH 进去执行
  `setsid nohup /opt/pp1/pp1-asr-tts-start.sh all > /models/pp1/logs/combined.log 2>&1 < /dev/null &`
  （没有自启；约 60 秒后 8082/8080 就绪，asr 预热 2~15 秒）
- **语音音色**：`/voices` 在镜像里是目录，音色文件放 `/models/voices` 后要 `cp /models/voices/* /voices/` 再重启 tts，否则报 `未知音色: male-fun`

## 开发环境镜像（devbox，2026-10-24）

未来开发机用 `pp1/devbox:0.1.0`：在 asr+tts 合并镜像上补了 node 22、codex、opencode 与常用工具（git / ripgrep / jq / tmux / vim-tiny）。

| 项 | 值 |
|---|---|
| 镜像 | `<registry>/pp1/devbox:0.1.0`（digest `sha256:0250343812…`） |
| 平台 artifact | `REPLACE-ME-ARTIFACT-ID` |
| 版本 | node v22.23.4、codex-cli 0.164.0、opencode v2.1.4、git 2.43.0、ripgrep 14.1.0 |
| 构建上下文 | `/data/build/pp1-devmachine/devbox/`（Dockerfile + `config/` + `dev-env-setup.sh`） |

**LLM provider 直连上游**（不经过本机 api-proxy 的 127.0.0.1:4001）：

- codex：`/etc/pp1/codex/config.toml`，`base_url = https://<llm-gateway>/v1`，`env_key = CLIENT_API_KEY_ASTRA`
- opencode：`/etc/pp1/opencode/opencode.json`，同样 base_url，`apiKey: {env:CLIENT_API_KEY_ASTRA}`
- 连通性实测：开发机 → `<llm-gateway>` 401（可达，需 key）；开发机 → `<llm-gateway>` 不通

**首次使用**：

```bash
/opt/pp1/dev-env-setup.sh      # 部署配置到 ~/.codex、~/.config/opencode，并在 ~/.bashrc 挂 key 加载
```

**key 放置（不落镜像、不落仓库）**：在项目卷上放一个 600 的文件

```
/models/pp1/secrets/astra.env     # 内容形如 export CLIENT_API_KEY_ASTRA=...
```

登录 shell 时由 `.bashrc` 里的 `[ -f ... ] && . ...` 自动加载。

**切换步骤**（现有开发机仍是旧镜像，换镜像要重建机器，会中断服务）：

1. 维护窗口：停现有开发机（`mlp machine stop`）
2. 用 `artifactId: REPLACE-ME-ARTIFACT-ID`、`rootfsSize: 25Gi` 新建机器（或删旧建新）
3. 挂同一个项目卷，`/opt/pp1/dev-env-setup.sh`，再跑 `/opt/pp1/pp1-asr-tts-start.sh all` 恢复服务

**注意**：镜像里不能有凭据，Dockerfile 末尾有一道 grep 检查（命中 `sk-…`/`Bearer …` 就构建失败）。

## 加一台 chat 开发机（2026-10-24）

两张 4090 全部交给平台纳管，k8s 里不再有 GPU Pod。

| 机器 | ID | 卡 | 跑什么 | 启动 |
|---|---|---|---|---|
| asr+tts | `REPLACE-ME-MACHINE-ID` | 卡0 | 合并镜像 | `/opt/pp1/pp1-asr-tts-start.sh all` |
| chat | `REPLACE-ME-MACHINE-ID` | 卡1 | vLLM + Qwen2.5-Omni-7B | `/models/pp1/chat-start.sh` |

- 镜像：chat 用 artifact `REPLACE-ME-ARTIFACT-ID`（vLLM 0.32.0），rootfs 45Gi
- 权重：`/models/chat/Qwen2.5-Omni-7B`（从 PVC `pp1-chat-models` 拷到项目卷，21G）
- 模板与解析器：`/models/pp1/chat/{qwen-omni-tools.jinja,omni_bare_json_tool_parser.py}`（从 ConfigMap `pp1-chat-template` 导出）
- 启动脚本：`/models/pp1/chat-start.sh`（参数同 `08-chat.yaml`，路径改到项目卷）
- 个人配额：`gpu-count=2`、`monthlyGpuHours=-1`
- 卷配额：资源组 `ceph-block` 120GiB、队列 100GiB（`PUT /v1/resource-groups/<rg>/volumes/ceph-block`、`PUT /v1/queues/<q>/volumes/ceph-block`）

### 重启恢复（两台各一条）

```bash
# asr+tts 机器
setsid nohup /opt/pp1/pp1-asr-tts-start.sh all > /models/pp1/logs/combined.log 2>&1 < /dev/null &
# chat 机器
setsid nohup /models/pp1/chat-start.sh > /models/pp1/logs/chat.log 2>&1 < /dev/null &
```

### 注意

- 两台机器**没有自启**，停机/重启后都要各跑一次上面的命令
- 卡只有 2 张：`12-asr-tts.yaml` 或 k8s 里的 `chat` Deployment 一旦拉起，就会和开发机抢卡（`Unschedulable: resource is overused`），必须保持 replicas=0
- NetworkPolicy `devmachine/ml-platform-devmachine-ingress` 里有一条允许 `pp1` 访问开发机端口的规则；如果平台 reconcile 覆盖它，brain 会连不上开发机

## 开发环境镜像 devbox（2026-10-24）

- 镜像：`<registry>/pp1/devbox:0.1.1`，digest `sha256:fefc5dbcef5be042e9b9439bd842c33b8fedec88c7d0c88005faab53c4bf954c`
- 平台 artifact：`REPLACE-ME-ARTIFACT-ID`
- 内容：asr+tts 合并镜像 + Node 22 + `@openai/codex` 0.164.0 + `@opencode/cli` 2.1.4 + git/rg/jq/tmux
- 配置模板：`/etc/pp1/codex/config.toml`、`/etc/pp1/opencode/opencode.json`，由 `/opt/pp1/dev-env-setup.sh` 部署到 home（幂等，先备份）
- 默认 provider：**zgcai**（codex `https://<llm-gateway>/plan/v3`、opencode `.../plan/v1`）；astra（`https://<llm-gateway>/v1`）作为备用
- key：放 `/models/pp1/secrets/zgcai.env` 与 `astra.env`（600，内容形如 `export CLIENT_API_KEY_ZGCAI=...` 或 `CLIENT_API_KEY_ZGCAI=...`；`.bashrc` 用 `set -a` 加载，两种写法都认）
- 镜像内**不含任何凭据**（Dockerfile 构建时 grep 校验）

### 切换开发机到新镜像

1. 删除旧机器（rootfs 会丢，权重在项目卷不受影响）
2. 用 artifact `REPLACE-ME-ARTIFACT-ID`、`ml.g4090.2xlarge`、`rootfsSize: 25Gi`、挂 `REPLACE-ME-VOLUME-ID` 的 `pp1` 到 `/models` 建机器
3. 进机器：`/opt/pp1/dev-env-setup.sh` → `setsid /opt/pp1/pp1-asr-tts-start.sh all &`
4. 重建 endpoint `asr:8082`、`tts:8080`，把 brain 的 `STT/TTS_API_BASE_URL` 指到新机器 Service
5. **音色**：新机器 rootfs 是新的，`/voices` 为空 → `cp /models/voices/* /voices/` 后重启 tts，否则 brain 报「未知音色: male-fun」

### 语音 brain 的 codex 实例（唯一）

```bash
/models/pp1/codex-voice-up.sh      # 起一个 tmux 会话 codex + 绑定 brain-listen（已有 listen 会拒绝）
/models/pp1/codex-voice-status.sh  # 看 tmux / listen / 日志
/models/pp1/codex-voice-down.sh    # 只停 listen，保留 codex 会话
```

只允许一个实例：一条 brain 队列对一个会话，开两个会出现同一条话注入两次。

## Arch 单机双卡形态（2026-10-24 上线）

一台 `ml.g4090.4xlarge`（2 卡 / 12c / 84GiB）跑全部服务与开发环境：

- 机器：`REPLACE-ME-MACHINE-ID`（pp1-devbox），rootfs 60Gi，挂项目卷 `pp1` 到 **`/data`**（`/models` 是兼容软链）
- 镜像：`pp1/devbox-arch:0.2.0`（artifact `REPLACE-ME-ARTIFACT-ID`，34GB）
  - Arch Linux 基础；vim/nvim/tmux/zsh/git/rg/fd/jq/tree/htop/uv/ffmpeg/node/go
  - 内含 asr（`/opt/conda`）、tts（`/opt/venv` + `/opt/llama`）、vLLM（`/opt/vllm`，python 3.12）
- 卡分配：卡0 = asr + tts（约 5GB）；卡1 = vLLM chat（约 27GB）
- 端口：asr 8082、tts 8080、chat 8000，均通过 `mlp machine endpoint` 注册

### 启动 / 恢复（没有自启，重启后手动跑）

```bash
# asr + tts（卡0）
setsid nohup /opt/pp1/pp1-asr-tts-start.sh all > /models/pp1/logs/combined.log 2>&1 < /dev/null &
# chat（卡1）——参数见 /models/pp1/chat-start.sh，若脚本存在直接跑
setsid nohup bash /models/pp1/chat-start.sh > /models/pp1/logs/chat.log 2>&1 < /dev/null &
```

### 开发环境（codex / opencode）

- `bash /opt/pp1/dev-env-setup.sh` 把配置模板部署到 `~/.codex/config.toml`、`~/.config/opencode/opencode.json`（幂等）
- 默认 provider：**zgcai**（codex `https://<llm-gateway>/plan/v3`、opencode `/plan/v1`）；astra（`https://<llm-gateway>/v1`）为备用
- key 放 `/models/pp1/secrets/zgcai.env` 与 `astra.env`（600），登录 shell 自动 source
- **镜像里没有 `gotools` 与 `~/.gotools.yaml`**（brain 桥需要）：
  `scp` 一份 `gotools` 到 `/usr/local/bin/`（755），并把 `~/.gotools.yaml`（600，含 brain.base_url/brain_id/token）放进 `/root/`
  这两样是"语音 brain 接 codex"的前置，重装机器后必须补

### 语音 brain 只接一个 codex 实例

```bash
bash /models/pp1/codex-voice-up.sh      # 起 tmux codex-voice + brain-listen 绑它（有 listen 在跑会拒绝）
bash /models/pp1/codex-voice-status.sh
bash /models/pp1/codex-voice-down.sh    # 只停 listen，保留会话
```

### 必须保持的约束

- k8s 的 `chat`、`asr-tts` 两个 Deployment 必须保持 `replicas: 0`（否则和开发机抢卡）
- `devmachine` 的 NetworkPolicy 里"允许 pp1 访问"那条可能被平台 reconcile 覆盖；覆盖后 brain 连不上开发机（转写/纠错 502），重新 patch 即可

## Arch 全合一开发机（2026-10-24）

一台 `ml.g4090.4xlarge`（2 卡）同时跑 asr+tts（卡0）与 vLLM chat（卡1），本身也是开发环境。

| 项 | 值 |
|---|---|
| 机器 | `REPLACE-ME-MACHINE-ID`（pp1-devbox） |
| 镜像 | `<registry>/pp1/devbox-arch:0.2.1`（artifact `REPLACE-ME-ARTIFACT-ID`，digest `sha256:ff3715ed…`） |
| 基础 | `archlinux:latest` + pacman 工具链（vim/nvim/tmux/zsh/git/rg/fd/jq/node/codex/opencode…） |
| 服务运行时 | 从 `pp1-asr-tts:0.1.0` 拷 `/opt/conda`、`/opt/llama`、`/opt/asr`、`/app`；从 `pp1/chat-vllm:v0.32.0` 拷 python3.12 与 dist-packages 到 `/opt/vllm` |
| 启动 | `/opt/pp1/pp1-all-start.sh all`（`asr-tts` / `chat` 也可单独起） |
| 端口 | asr 8082、tts 8080、chat 8000（平台 endpoint 同名） |
| 默认 provider | codex/opencode 默认 `zgcai`（`https://<llm-gateway>/plan/v3`），astra 备用；key 从 `/models/pp1/secrets/{zgcai,astra}.env` 加载 |

构建这个镜像时踩过的坑（都已在 Dockerfile / 启动脚本里固化）：

- Ubuntu 的 venv 里 `python3 -> /usr/bin/python3`，搬到 Arch 会变成 3.14 → tts 前端不能用原 venv，改成用 Arch python 重建，装 `fastapi uvicorn[standard] pydantic python-multipart`（**multipart 必装**，否则 FastAPI 一启动就崩）
- vLLM 的 triton 会在启动时现编 `cuda_utils.c`，需要 `Python.h` 和多架构 `pyconfig.h`（`/opt/vllm/include/{python3.12,x86_64-linux-gnu/python3.12}`），并设 `C_INCLUDE_PATH=/opt/vllm/include`
- `llama-moss-tts` 的 `.so` 在 `/opt/llama/bin`，CUDA 运行时从旧镜像拷到 `/opt/cuda/lib64`，两者都要进 `LD_LIBRARY_PATH`
- tts 启动时扫描 `/voices`，而镜像里它是空目录；音色在项目卷 `/models/voices`，`pp1-all-start.sh` 会先 `cp` 过去
- 停服务时**不要**用 `pkill -f "vllm serve"` 这类模式——它会匹配到 ssh 会话自己的命令行，把会话一起杀掉

重启恢复（没有自启）：

```bash
ssh -p REPLACE-ME-SSH-PORT REPLACE-ME-MACHINE-ID@REPLACE-ME-HOST
nohup /opt/pp1/pp1-all-start.sh all > /models/pp1/logs/all.log 2>&1 &
```

回退：旧的两台 1 卡形态仍可用，用 `pp1/devbox:0.1.1`（Ubuntu）与 `pp1/chat-vllm` 分别建 1 卡机器即可。

## 挂载点 /data（2026-10-24 调整）

项目卷 `REPLACE-ME-VOLUME-ID` 的 `pp1` subpath 现在挂到 **`/data`**（原来挂 `/models`）。
机器上有一条兼容软链 `ln -sfn /data /models`，所以所有按 `/models` 写的脚本（启动脚本、codex-voice 脚本）不用改。

卷容量 140GiB（资源组 160GiB / 队列 140GiB）。同步完成后用量 64GiB、可用 77GiB。

### 同步本机 /data/git_gh

```bash
rsync -az --info=progress2 \
  --exclude='target/' --exclude='node_modules/' --exclude='build/' \
  --exclude='dist/' --exclude='__pycache__/' --exclude='*.tar.gz' \
  --exclude='*.tar.xz' --exclude='*.zip' --exclude='*.iso' \
  -e "ssh -p REPLACE-ME-SSH-PORT -o StrictHostKeyChecking=no" \
  /data/git_gh/ REPLACE-ME-MACHINE-ID@REPLACE-ME-HOST:/data/git_gh/
```

本机 63GB，排除构建产物后实测传输 36.8GB，目标 `/data/git_gh` 占 35GB。`.git` 保留，历史可用；中断后重跑同一条命令即可（增量）。

- dry-run 复核只剩 2 个 gradle `config.properties`（root 600）和 5 个 nginx 临时目录
  `codex/api-proxy/{client_body_temp,fastcgi_temp,proxy_temp,scgi_temp,uwsgi_temp}`（root 700）未同步，
  rsync 报 code 23 属正常，这些内容不需要（也不应）同步
- 开发机上没有 uid 1000 用户（登录用户就是 root），同步后要执行
  `chown -R root:root /data/git_gh`，否则 git 报 `dubious ownership`

### 重装机器后必须补的三件事

1. `ln -sfn /data /models`（兼容软链）
2. `cp /data/voices/* /voices/` 再起 tts —— 否则报 `未知音色: male-fun（现有: default）`
3. `/data/pp1/bin/gotools` 已在卷上；`/root/.gotools.yaml` 软链到 `/data/pp1/secrets/gotools.yaml`

另外 vLLM 不在 PATH 里：`/data/pp1/chat-start.sh` 开头已加 `export PATH=/opt/vllm/bin:$PATH`。

镜像 `0.2.1` 的 `dev-env-setup.sh` 只写 `.bashrc`（Arch 默认 shell 是 zsh，导致 key 不加载）；
源码已改成同时写 `.bashrc`/`.zshrc`、把 `/models/pp1/bin` 加进 PATH、软链 gotools 配置，
下次重建镜像（`0.2.2`）后自动生效；现有机器已手工补齐。

持久化内容都在卷上：`/data/pp1/{bin,secrets,logs,workspace}`、`/data/{asr,tts,chat,voices}`。

## 开发环境对齐 astra（dotfiles / codex / dsh）

配置只有一个源：`/data/build/pp1-devmachine/devbox-arch/config/dotfiles/`。构建镜像时整棵拷到
`/etc/agent-dotfiles`；开发机上另有一份在项目卷 `/data/pp1/dotfiles`（可改、重启不丢）。
`dev-env-setup.sh` 两处都能用，负责把配置幂等软链到家目录。

```bash
bash /data/pp1/dotfiles/deploy.sh              # 等价于 /opt/pp1/dev-env-setup.sh
bash /data/pp1/dotfiles/deploy.sh --no-shell   # 不改登录 shell
```

落地清单：

- 软链到 `/data/pp1/dotfiles`：`.zshrc`、`.tmux.conf`、`.vimrc`、`.condarc`、`.bash_functions/`、
  `.config/{nvim,atuin/config.toml,starship.toml}`
- 插件目录放卷上，家目录只放软链：`~/.vim`（20 个插件）、`~/.local/share/nvim`、`~/.tmux`、
  `~/.config/coc`（`coc-settings.json` 单独指回 dotfiles，插件扩展留在卷上）
- codex：`~/.codex/{config.toml,AGENTS.md,RTK.md,gopls.md,hooks.json,brain-speak-hook.sh,brain-speak-notify.sh}`
- dsh：`~/.dsh/profiles/{dsh-tui,headless}/cordis.patch.yml`
- 同名真实文件先改名成 `.bak-<时间>`；重复执行不再产生备份（已验证）

登录 shell 从 bash 换成 zsh，`/etc/shells` 补了 `/usr/sbin/zsh`。

### codex 相对 astra 的改动

- provider 直连网关：zgcai `https://<llm-gateway>/plan/v3`，astra 备用 `https://<llm-gateway>/v1`
  （astra 的 `http://REPLACE-ME-HOST:8080/...` 是 tun-env 内的 api-proxy，开发机访问不到）
- 删掉两处 `model_catalog_url`，因此 `codex` 会提示 `Model metadata for deepseek-v4.1-flash not found`，
  只是拿不到模型元数据，不影响请求
- AGENTS.md 里两个 `@import` 由 `/home/yuzx/.codex/` 改成 `/root/.codex/`

### dsh / dsh-tui

```bash
npm i -g @deepseek-ai/dsh@0.2.1-rc.2 @deepseek-harness-tui/dsh-tui@latest
dsh plugin --profile dsh-tui add -w @deepseek-harness-tui/dsh-tui@0.17.0
```

- provider 写在 profile 的 `cordis.patch.yml`：dsh 0.2.1-rc.2 会把 `~/.dsh/settings.yaml` 迁走
  （改名 `.imported`），不要再往那里写
- `dsh-tui` profile 的 `dsh-tui` 条目要求 `provider` 与 `model` 成对；`headless` profile 只放
  provider + `agent-default-model`
- 验证：`dsh headless "Reply with exactly: OK"` 返回 `OK`；
  `dsh --profile dsh-tui --dump-config` 能看到 `llm-pi-ai.config.providers.zgcai`
- 已知告警：`patch: entry "tool-ralph" not found` 来自 dsh-tui 0.17.0 自带补丁与 dsh 0.2.1-rc.2 的
  版本差，退出码 0，不影响启动
- model 的 `contextWindow` 不写死，用 dsh 默认 262144（没有实测依据不虚报）

### 和 astra 还差什么

- 缺 AUR 包：`autojump-rs`（`.zshrc` 里的 `j` 命令）、`obscura` 等 astra 镜像里的工具，按需再补
- 刻意不拷 astra 的 `.agents`、`.codex/skills`、`.codex/memories`、`.dsh` 会话历史
- 四个 MCP（codegraph / gopls / mcp-dap-server / gotools-brain-bridge）在本机都能拉起；
  brain-bridge 还依赖 `/data/pp1/secrets/gotools.yaml` 与 brain 到开发机的网络策略
- Dockerfile 已改成 `COPY config/dotfiles/`、补 `zsh` 插件/`atuin`/`gopls`/`dsh`/`codegraph`/
  `mcp-dap-server`，但镜像尚未重建；重建后新机器开箱即用
