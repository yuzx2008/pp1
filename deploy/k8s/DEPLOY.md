# pp1 部署到单节点 k8s

把 `docker-compose.yml` 里的 asr / tts / brains 三个服务翻译成 k8s 资源，
跑在单节点集群上，由 ingress-nginx 提供 HTTPS。只动 `pp1` namespace。

本文里凡是跟环境有关的值都不写死，只出现占位名：`<域名>`、`<镜像仓库>`、
`<storageClass>`、`$CLUSTER_HOST`（集群的 ssh 别名或 `user@host`）。真实值在
`local.env` 里，见下一节。

## 文件

| 文件 | 内容 |
|---|---|
| `00-namespace.yaml` | namespace `pp1` |
| `01-storage.yaml` | `pp1-models`（30Gi）、`pp1-voices`（1Gi），都是 `@@STORAGE_CLASS@@` RWX |
| `02-config.yaml` | ConfigMap `pp1-env`：compose 的 `.env` 逐项翻译（MOSS_* / STT_* / TTS_* / MIGHT_*） |
| `03-fetch-weights.yaml` | 权重下载脚本 ConfigMap（生效）+ 下载 Job（**已注释**，见「权重下载是一次性动作」） |
| `04-asr.yaml` | asr Deployment + Service（1 张 GPU） |
| `05-tts.yaml` | tts Deployment + Service（1 张 GPU） |
| `06-brain.yaml` | brain Deployment + Service（不占 GPU） |
| `07-ingress.yaml` | 一个通配符 Certificate + 三个 Ingress（关缓冲、长超时） |
| `08-chat.yaml` | chat（vLLM + Qwen2.5-Omni-7B）PVC / 模板 ConfigMap / Deployment / Service（1 张 GPU） |
| `verify-protocol.py` | 协议级端到端验收脚本（手写 MessagePack，纯标准库） |
| `local.env.example` | 本地部署值模板：镜像仓库 / ingress 域名 / ClusterIssuer / storageClass / 权重暂存目录 |
| `render.sh` | 读 `local.env`，把清单里的 `@@占位符@@` 替换掉，输出到 `rendered/` |

Secret `pp1-brain-token` 不在仓库里（含 token，靠命令创建，见下面「brain 鉴权」一节）。

## 本地化配置：`local.env` + `render.sh`

清单本身是**可提交的模板**：跟环境绑定的地方写成 `@@IMAGE_REGISTRY@@` 之类的占位符，
真实值放在仓库外（准确说是不进 git）的 `local.env` 里，由 `render.sh` 渲染成 `rendered/*.yaml`。

```bash
cd deploy/k8s
cp local.env.example local.env   # 第一次：按自己的环境填
./render.sh                      # 结果在 rendered/，一次渲染全部清单
kubectl apply -f rendered/
```

| 占位符 | 含义 | 出现在 |
|---|---|---|
| `@@IMAGE_REGISTRY@@` | 镜像仓库（不带结尾斜杠），清单里写成 `@@IMAGE_REGISTRY@@/pp1/<服务>:<tag>` | 04 / 05 / 06 / 08 |
| `@@STORAGE_CLASS@@` | PVC 的 storageClassName，要支持 ReadWriteMany | 01 / 08 |
| `@@INGRESS_DOMAIN@@` | ingress 基础域名，三个 host 是 `pp1.` / `pp1-asr.` / `pp1-tts.` 加它，证书签 `*.<域名>` | 07 |
| `@@CLUSTER_ISSUER@@` | 上面那张证书用的 cert-manager ClusterIssuer 名字 | 07 |
| `@@WEIGHTS_DIR@@` | 本机暂存权重大模型的目录（下载脚本的默认 `DEST`） | 08 |

几点约定：

- `local.env` 与 `rendered/` 都在 `.gitignore` 里；新克隆的人只需要 `local.env.example` 加自己的值。
- 渲染时**已经存在的同名环境变量优先**，临时换一两个值不必改文件：
  `IMAGE_REGISTRY=registry.example.com:5000 ./render.sh`。
- 值里有 `|`、`&`、`\` 会直接报错退出（这些字符会破坏替换表达式）；渲染后有占位符残留也报错，
  不会产出半成品清单。
- namespace（`pp1`）与服务名（`asr` / `tts` / `brain` / `chat`）不是本地位，在清单里写死：
  brain 的 STT/TTS 地址正是靠这些名字对上 compose 的。
- `@@STORAGE_CLASS@@` 只在**新建 PVC 时**能改：PVC 的 `storageClassName` 创建之后不可变
  （实测对这个值做服务端 dry-run 会被拒：`spec is immutable after creation`），
  换存储要新建 PVC 再搬数据。`@@WEIGHTS_DIR@@` 只影响重下权重时的默认落盘位置，改它无副作用。

## 当前状态（2026-10-20 部署并验收；同日加鉴权 token、TTS 常驻改 2；10-21 chat 改走 device plugin、asr 改 0.1.2 修冷启动超时、asr 改 2 副本滚动更新）

| 项 | 值 |
|---|---|
| pod | `asr-*` **2 个副本**、`tts-*`、`brain-*`、`chat-*` 均 Running（两个权重下载 Job 都已删，权重留在 PVC 里） |
| GPU | 节点可分配 `nvidia.com/gpu: 4`（time-slicing，见下节），**pp1 已用满 4/4**。物理卡 A：tts 2×~6860 + asr 4976 = 18748 MiB；物理卡 B：chat 26890 + asr 4976 = 31881 MiB；brain 不占 |
| 权重 | PVC `pp1-models` → `asr/Qwen3-ASR-1.7B/**` + `tts/*.gguf`（12.7 GB） |
| 鉴权 | Secret `pp1-brain-token`（bearer token，四个端点都校验）；给人用的那一份副本自己挑地方放，权限 600 |
| 宿主机挂载点 | `<kubelet root>/pods/<pod-uid>/volumes/kubernetes.io~csi/<pv 名>/mount`（kubelet root 是可配的，用 `kubectl get node -o jsonpath='{.items[0].status.nodeInfo…}'` 或登录节点 `ps -o args= -C kubelet` 查） |
| 存储子卷 | 两个 PVC 各自对应存储后端的一个子卷，名字用 `kubectl -n pp1 get pv -o yaml` 看 |

tts 的常驻 daemon 是**懒加载**：pod 起来只把两个 daemon 进程和 socket 拉好
（`/run/moss/serve.sock`、`/run/moss/serve-1.sock`），模型要等各自第一次被请求时才加载进显存，
之后一直常驻。所以刚重启完 `nvidia-smi` 里 tts 只有几 MiB，发两条并发请求才看得到两份 6.8 GB。

证书为什么是通配符：DNS-01 的 TXT 记录挂在基础域上，一个 Certificate 里放三个 SAN 时
会并发发起三个挑战，互相把 TXT 顶掉（实测只有第一个 valid，另两个一直 pending）。
改成单个通配符 dnsName 后一次签发成功，三个 host 共用一张证书。

## compose → k8s 对照

| compose | k8s |
|---|---|
| `models/asr:/models:ro` | PVC `pp1-models` subPath `asr` → `/models`（只读）；`ASR_MODEL=/models/Qwen3-ASR-1.7B` |
| `models/tts:/models:ro` | 同一个 PVC subPath `tts` → `/models`（只读） |
| `./voices:/voices` | PVC `pp1-voices` → `/voices`（读写，要写 `.codes.bin`） |
| `./run:/run/moss`、`./logs/tts:/var/log/moss` | emptyDir（只用于 socket 和日志） |
| `./logs/brains:/app/logs` | emptyDir |
| `ports: 8082 / 6677:8080 / 8787` | ClusterIP Service `asr:8082`、`tts:8080`、`brain:8787` |
| `deploy.resources.devices`（GPU） | `resources.limits."nvidia.com/gpu": 1`（asr、tts 各一张，brain 不要） |
| compose 默认网络里的名字 `asr` / `tts` | 同名 Service，所以 brain 的 `STT_API_BASE_URL` / `TTS_API_BASE_URL` 一个字都不用改 |
| `restart: unless-stopped` | Deployment 默认重启策略 |
| `healthcheck` | startupProbe / readinessProbe / livenessProbe（httpGet `/health`） |
| `init: true`（tts） | k8s 没有对应物，见“与 compose 的差异” |

## 部署顺序

```bash
cd deploy/k8s
export CLUSTER_HOST=<集群的 ssh 别名或 user@host>   # 下面命令里的 $CLUSTER_HOST
./render.sh                                        # 先渲染，apply 的是 rendered/ 里的文件
# 只在“新集群 / 换模型版本”时走这几步：先把 03-fetch-weights.yaml 里注释掉的 Job 恢复
for f in 00-namespace 01-storage 02-config 03-fetch-weights; do
  ssh "$CLUSTER_HOST" 'kubectl apply -f -' < rendered/$f.yaml
done
# 等 Job 完成（约 13.6 GB，实测 ~19 MB/s）
ssh "$CLUSTER_HOST" 'kubectl -n pp1 wait --for=condition=complete job/pp1-fetch-weights --timeout=3600s'
# 权重下完之后 Job 可以删掉（PVC 里的文件不受影响）
ssh "$CLUSTER_HOST" 'kubectl -n pp1 delete job pp1-fetch-weights'

# 音色：male-fun.wav + 预计算的 .codes.bin 放进 pp1-voices
scp voices/male-fun.wav "voices/male-fun.$(...).codes.bin" "$CLUSTER_HOST:/tmp/"
ssh "$CLUSTER_HOST" 'kubectl -n pp1 cp /tmp/male-fun.wav <任意挂载了 pp1-voices 的 pod>:/voices/'

for f in 07-ingress 04-asr 05-tts 06-brain; do
  ssh "$CLUSTER_HOST" 'kubectl apply -f -' < rendered/$f.yaml
done
```

`06-brain` 之前要先建好 Secret `pp1-brain-token`，否则 brain pod 会卡在 `CreateContainerConfigError`。

### 权重下载是一次性动作（Job 已从清单里摘掉）

两套权重都只在**第一次部署**（或换模型版本、PVC 被清、换新集群）时下，下完就一直躺在 PVC 里。
**两个下载 Job 都已经从清单里摘掉**（都是注释形态），整份 `kubectl apply -f deploy/k8s/` 不会再下任何权重：

| 权重 | 大小 | 下载器 | 现在的状态 |
|---|---|---|---|
| asr + tts（PVC `pp1-models`） | 12.7 GB | `03-fetch-weights.yaml` 的 Job（35 行） | 集群里已删；清单里**已注释掉** |
| chat（PVC `pp1-chat-models`） | 20.8 GB | `08-chat.yaml` 的 Job（33 行） | 集群里已删；清单里**已注释掉** |

两处只有 `fetch.sh` 的 ConfigMap 还生效（注释只包住 Job 那段，脚本内容与集群里的 ConfigMap 逐字节一致，
已用 sha256 核对）。整目录 dry-run 的结果（2026-10-21）：20 个资源、**没有任何 Job**、`kubectl diff` 无差异。

怎么确认权重还在（以 chat 为例，asr/tts 同理）：

```bash
ssh "$CLUSTER_HOST" 'kubectl -n pp1 exec deploy/chat -- ls -la /models/Qwen2.5-Omni-7B'
ssh "$CLUSTER_HOST" 'kubectl -n pp1 exec deploy/chat -- cat /models/Qwen2.5-Omni-7B/.fetch-ok'   # 下完才会写这个标记
ssh "$CLUSTER_HOST" 'kubectl -n pp1 exec deploy/chat -- sha256sum /models/Qwen2.5-Omni-7B/model-00005-of-00005.safetensors'
# 期望 b8b18276481ba8cdf4fe2c98ac4c7a2da6e0d1c8a51850d162a391760cb2b81e（清单里 pin 的值）
```

要重下：把对应文件里那段 Job 的行首 `# ` 去掉（`03-fetch-weights.yaml` 35 行 / `08-chat.yaml` 33 行）
→ `apply` → 等 Job 完成 → `kubectl -n pp1 delete job pp1-fetch-weights`（或 `pp1-fetch-chat-weights`）
→ 再把它们注释回去。

## 镜像来源

镜像不在仓库里构建，推在自己的 registry `<镜像仓库>/pp1/` 下（地址写进 `local.env` 的
`IMAGE_REGISTRY`），清单里写**完整引用**：

| 服务 | 镜像 | digest |
|---|---|---|
| asr | `<镜像仓库>/pp1/asr:0.1.2` | `sha256:cf360566fcb8b7c09cd2f9985955ac94183c7f416a1edfb2c11c5f70b13ad480` |
| tts | `<镜像仓库>/pp1/tts:0.1.0` | `sha256:6e6f2037ff77b7c05c6c88b637de50dca14a1a010a43edb9f5c5fe7300b4ddd1` |
| brain | `<镜像仓库>/pp1/brain:0.1.0` | `sha256:82b3e37d0605b415cdb6aadeee4539cbc9369924139e505800c721eb4d0f8efe` |

asr 的 `0.1.1` 是预热策略不完整的中间版本（见文末「已修复」一节）。`0.1.2` 才是最终版本，
**registry 上的 `0.1.1` 标签已于 2026-10-21 删除**（manifest 与 blob 现状见下）。

`imagePullPolicy: IfNotPresent`。为什么必须带 registry 前缀：`pp1/asr:0.1.0` 这种短名在 kubelet 里
等价于 `docker.io/pp1/asr:0.1.0`，只有本机 `load` 过才跑得起来，换节点或 prune 之后必然拉不到；
写全之后任何节点都能自己拉。registry 的信任与凭据配置在节点侧
（containerd 的 `certs.d/<registry>/hosts.toml`），所以**不需要 imagePullSecret**。

换 tag 的正确姿势：`kubectl set image` 或改清单再 `apply`。asr 已经是 2 副本滚动更新
（见下节），换 tag 不掉线；tts 仍是 `Recreate`，换 tag 会短暂没有语音能力。

### 删 registry 上的旧标签（以 `0.1.1` 为例）

```bash
export PATH=$PATH:~/go/bin
crane ls <镜像仓库>/pp1/asr                    # 列标签
crane delete <镜像仓库>/pp1/asr@sha256:<该标签的 digest>   # 按 digest 删 manifest
```

`crane` 会自己读 `~/.docker/config.json` 里的凭据，不需要把口令贴到命令行。
**删之前先确认没有任何清单/Deployment 还在用这个标签**（`kubectl -n pp1 get deploy -o jsonpath` 看一眼即可）。

删完的实际情况（2026-10-21 实测）：tag 与 manifest 立刻 404，其它标签的 digest 不变；
**blob 不会自动回收**——`distribution` 只在跑 `registry garbage-collect` 时才清没有 manifest 引用的 blob，
而 0.1.1 与 0.1.2 共用 8 层（5.98 GiB），只有 1 个 3514 字节的独有层和一个 config blob 变成无引用，
所以真跑 GC 也只能省几 KB。节点上 containerd 里同样留着 `pp1/asr:0.1.1` 这个标签引用，
要清就是 `sudo nerdctl --namespace k8s.io image rm <镜像仓库>/pp1/asr:0.1.1`
（现役用的是 `0.1.2`，删这个标签不影响任何在跑的容器）。

## 访问地址

`*.<域名>` 是通配 DNS，指向 ingress 所在的节点地址，不需要逐个加记录。
证书用通配符（`*.<域名>`），所以三个 host 共用一张证书。

| 用途 | 地址 | 后端 |
|---|---|---|
| brain（手机/agent 连这个） | `https://pp1.<域名>` | `brain:8787` |
| ASR 健康检查 / 转写 | `https://pp1-asr.<域名>/health` | `asr:8082` |
| TTS 健康检查 / 合成 | `https://pp1-tts.<域名>/health` | `tts:8080` |

三个 Ingress 都关掉了缓冲（`proxy-buffering: off`、`proxy-request-buffering: off`），
并把 `proxy-read-timeout` / `proxy-send-timeout` 调到 3600 秒、`proxy-body-size` 放宽到 64m。
不关缓冲的话，brain 的“前导 + 连续 Ogg 流”会被 nginx 攒成一坨，手机端要等整段合成完才出声。

## 验收

在 ingress 所在的节点上跑（脚本自己连 127.0.0.1:443，SNI 用真实主机名，绕开节点上的 VPN fake-ip）：

```bash
scp deploy/k8s/verify-protocol.py "$CLUSTER_HOST:/tmp/"
ssh "$CLUSTER_HOST" "BRAIN_HOST=pp1.<域名> ASR_HOST=pp1-asr.<域名> TTS_HOST=pp1-tts.<域名> \
  BRAIN_TOKEN=\$(cat /tmp/brain-token) python3 /tmp/verify-protocol.py"   # token 先送到 /tmp/brain-token
```

脚本做五件事：ASR/TTS 经 ingress 的 `/health`、TTS 合成一段 Ogg Opus、
把这段音频回灌 `/human-to-brain` 看转写、`/agent-to-brain` 写一条回复、
`/brain-to-human` 读前导并打出“首字节 / 前导到手 / 每秒累计字节”的时间线
（时间线是判断缓冲有没有关掉的直接证据：前导应该几十毫秒就到，音频随后持续增长）。

## brain 鉴权

brain 的四个端点（`/human-to-brain`、`/brain-to-human`、`/agent-to-brain`、`/brain-to-agent`）
统一走 `Authorization: Bearer <token>`，服务端读的是环境变量 `MIGHT_BRAINS_TOKEN`：

- **空字符串 = 不鉴权**（规格 §0.2：token 为空时客户端不发这个头，服务端也就不能把“没有头”判成失败）。
- 非空则四个端点全部校验，不匹配返回 `401 token 无效`；客户端（手机 App、`brain-bridge`）**不要重试 401**。
- 比较是 `timingSafeEqual`，长度不等直接判否。

token 不能进 ConfigMap（`kubectl get cm -o yaml` 和仓库都会看到明文），所以：

```bash
# 生成并落一份给人用的副本（目录 700、文件 600），换 token 就是重跑这两条
mkdir -p ~/.pp1-secrets && chmod 700 ~/.pp1-secrets
openssl rand -hex 24 > ~/.pp1-secrets/brain-token && chmod 600 ~/.pp1-secrets/brain-token

# 交给集群（走 stdin，不进 shell 历史也不出现在 ps 里）
cat ~/.pp1-secrets/brain-token | tr -d '\n' | ssh "$CLUSTER_HOST" \
  'kubectl -n pp1 create secret generic pp1-brain-token --from-file=MIGHT_BRAINS_TOKEN=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -'

# brain 重新读取环境变量
ssh "$CLUSTER_HOST" 'kubectl -n pp1 rollout restart deploy/brain'
```

用的地方有三处，改 token 要一起改：

| 谁 | 位置 |
|---|---|
| brain 服务端 | Secret `pp1-brain-token` → `06-brain.yaml` 的 `envFrom.secretRef` |
| 手机 App | App 里的 brain 配置填同一个 token |
| codex 桥 | 跑桥的那台机器上 `~/.gotools.yaml` 的 `brain.token`（或 `BRAIN_TOKEN` 环境变量） |

`brain` 重启会清空内存里的会话状态（brain_id 上下文、待发队列），在途的长轮询会断，客户端重连即可。

## chat 端点（自建，brain 的 ASR 修订用）

部署在同一个 namespace（清单 `08-chat.yaml`，vLLM + `Qwen/Qwen2.5-Omni-7B` 的 thinker，
权重在独立的 PVC `pp1-chat-models`），集群内地址 `http://chat:8000/v1`。brain 侧接线：

```yaml
MIGHT_CHAT_API_BASE_URL: http://chat:8000/v1
MIGHT_CHAT_API_KEY: pp1-local      # 必须非空；本地 vLLM 不校验值
MIGHT_CHAT_MODEL: qwen2.5-omni-7b
```

它是给 brain 后台的 **ASR 修订**用的：同一个 brain_id 每写 3 次历史（`dirty === 3`）跑一轮，
把最近最多 7 条音频的 base64（OpenAI `input_audio` 格式）连同转写一并发过去，让模型判断
“转写有没有把 agent 带偏”；模型认为偏了就会调 `notify(warning)`，brain 把文本包成
`<asr-warning>…</asr-warning>` 塞进该 brain 的 agent 队列（手机/agent 侧按普通消息收）。
端点必须**原生吃音频**，纯文本模型会把请求打回来；本次实测请求体带 3 段 `input_audio`、
`stream: true`、`reasoning_effort: "high"`、`tools: [notify]`，vLLM 全部接受。

怎么确认这条链路真的活着（复现命令）：

1. 同一个 brain_id 连续发 3 次 `/human-to-brain`（带 token、msgpack 音频）。
2. brain 的 stdout 应当出现 `[llm] <uuid> <status> <ms>`（`status` 200 才算通），出问题会打
   `[revise] <brainId> 失败 <err>`。
3. 想看到底发了什么，把 `MIGHT_LOG_LLM` 设成 `"1"` 重启 brain，原始请求/响应会落到
   `/app/logs/revise/<日期>/<uuid>/{request.json,response.json}`（**含完整对话内容**，
   只看别外传；`/app/logs` 是 emptyDir，pod 一次重建就没了）。查完记得恢复 `"0"`。
4. 有没有产生警告，就看该 brain_id 的 `/brain-to-agent` 队列里有没有 `<asr-warning>`
   （没有 = 模型认为转写没问题，属正常结果）。

**已知的上游小毛病（不是本次接线引入的）**：vLLM 在 `stream=true` 且没带
`stream_options.include_usage` 时不返回 `usage`，brain 于是退化成用
`JSON.stringify(conv).length / 4` 估算 token，而 revise 上下文里塞了几段 base64 音频
（≈140 KB），估算值直接顶到 3.5 万 > 10240 的阈值，**每轮 revise 都会顺带触发一次历史摘要**
（`maybeCompression`，超长时还会把历史截到最近 12 条）。功能上无害（只是多一次 LLM 调用、多一段摘要），
上面第 3 步的日志里一次 revise 出现两个 `[llm]` 就是这两条。

## GPU 分配：device plugin 开 time-slicing（2026-10-21 改动 kube-system）

测试环境是 2 张 48 GB 卡，原先 device plugin 只上报 `nvidia.com/gpu: 2`，
asr / tts 各占 1 张后，chat（vLLM）就没有名额可用，只能靠
`NVIDIA_VISIBLE_DEVICES` 直通绕过 device plugin——那张卡的显存分配只有我们自己知道，
k8s 也不记账。现在给 device plugin 开 **time-slicing**（每张物理卡切成 2 个可分配单元，
共 4 个），chat 改成正规的 `resources.limits: nvidia.com/gpu: 1`。

**注意：这动的是 `kube-system` 的既有资源，不是 pp1 自己的清单。** 清单的源头在
集群自己的仓库/部署方式里（本仓库之外），大致要改三处：

```yaml
# 新增 ConfigMap nvidia-device-plugin-config：
#   version: v1 + flags.migStrategy: none + sharing.timeSlicing.resources
#   （resources 里每张卡配 replicas: 2）
# DaemonSet 加 --config-file=/etc/nvidia/device-plugin/config.yaml，并挂上面这个 ConfigMap
```

（本地测试环境是把这个开关放进集群自己的 ansible 变量里，默认关，只对这台机器打开；
你换集群的话按自己那套下发方式改即可。）当前集群上的实际形态：

```
configmap/nvidia-device-plugin-config        kube-system
daemonset/nvidia-device-plugin-daemonset     kube-system（镜像与 args 同前 + --config-file）
```

验收证据（2026-10-21）：

- 节点容量 `nvidia.com/gpu: 4`（改前 2）；`RegisteredDevices` 变成
  `GPU-<卡 A>…::0/::1`、`GPU-<卡 B>…::0/::1` 四个带副本号的单元。
- chat 容器里 `NVIDIA_VISIBLE_DEVICES=GPU-<卡 B>-…`（插件按实际分配注入），
  chat 清单里已删掉手写的 `NVIDIA_VISIBLE_DEVICES` / `CUDA_VISIBLE_DEVICES`。
- chat 真实推理：把一段 TTS 合成的 Ogg（内容是「你好，世界。」）用
  `input_audio` 发给 `/v1/chat/completions`，回答 `你好世界`。
- 重启 device plugin 期间 asr / tts / brain 的 pod UID、容器 ID、启动时间全部未变，
  GPU 进程 PID 也未变（不是重建，是真没碰到）。

### 已知代价与风险（time-slicing 的固有限制）

1. **没有显存隔离**：只是时间片共享，谁超了都会 OOM，卡上邻居要自己按最坏情况留余量。
   chat 的 `--gpu-memory-utilization=0.55`（≈27 GB）就是按「和另一个常驻服务共卡」算的：
   现在是和 asr（4976 MiB）共卡 1，卡上还剩约 17 GB；邻居以后涨显存要重新算这个比例。
2. **落在哪张物理卡不由我们决定**：`limits` 只保证拿到一个单元，不保证和谁同卡。
3. **开启前的存量 pod 会留下过期分配**：kubelet 的分配记录（`podDevices`）只在 pod 结束后清理，
   而切成 4 个单元后原来的裸 UUID 已经不存在了。装了新配置之后**没有重建过的 pod**
   （这里就是 tts）如果容器重启或者节点重启，kubelet 会报
   `previously allocated devices are no longer healthy`，pod 起不来，要手动删一次 pod 才恢复。
   想彻底干净，在维护窗口里把存量 pod 滚一遍即可：

   ```bash
   kubectl -n pp1 rollout restart deploy/tts    # tts 常驻 daemon 是懒加载，起来后第一次请求才占显存
   ```

### 常见症状：四个 GPU 进程全挤在一张卡上

time-slicing **只按“单元份数”分配，不看显存**，而且分配是“补齐式”的：谁后创建就挑当前
占用单元最少的那张卡。上面这种“存量 pod 带旧分配 + 中途改过切片配置”的组合，
结果就是某个时刻四个单元全落在同一张卡、另一张空着（实测过：一张 45520/49140 MiB，
另一张 33 MiB，只剩 3.6 GB 余量，随时可能 OOM）。

拨回来的操作就一句：

```bash
kubectl -n pp1 rollout restart deploy/tts     # 换成卡上单元占用最少的那个服务即可
```

原理：pod 重建会重新走一遍分配器，它按“当前还有几个空闲单元”挑卡，所以空卡会被优先选中；
实测 tts 重建后从 `GPU-<卡 B>…`（无副本号的旧分配）换到 `GPU-<卡 A>…::0`，
四进程从“全在一张卡”变成“卡 0 两份 tts、卡 1 asr + chat”。
受影响的服务重建期间会短暂不可用（tts 是懒加载，起来后第一次请求才占显存）。

### 回滚

```bash
# 1) 恢复 device plugin（改之前先备份原 DaemonSet，再从这个备份恢复）
kubectl apply -f <备份目录>/ds-before.yaml
kubectl -n kube-system delete configmap nvidia-device-plugin-config
kubectl -n kube-system rollout status ds/nvidia-device-plugin-daemonset

# 2) chat 退回直通写法（把 08-chat.yaml 里 resources 的 nvidia.com/gpu 去掉、
#    加回 NVIDIA_VISIBLE_DEVICES/CUDA_VISIBLE_DEVICES，再 apply）
```

回滚后节点容量回到 2；此时 chat 若已按 4 单元时代分配，同样会留下过期分配，需要重建一次 chat。

## ASR 滚动更新：2 副本，重启/升级不掉线（2026-10-21）

以前 asr 是 `replicas: 1` + `Recreate`：一重启，Service 一个可用端点都没有，brain 那几秒的
转写请求直接失败。现在改成：

```yaml
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate: {maxSurge: 0, maxUnavailable: 1}
```

**为什么不按常规写 `maxSurge: 1, maxUnavailable: 0`**：节点只有 4 个 GPU 单元
（2 张卡 × time-slicing 2 份），asr 2 + tts 1 + chat 1 已经用满；surge 出来的第 3 个 asr 副本
没有单元可拿，会一直 `Pending`，rollout 反而永久卡住。`maxUnavailable: 1` 配 2 副本的语义是
“任何时刻至少 1 个 Ready 副本在服务”，也就是这个方案要的效果。想用 `maxSurge: 1` 得先把
切片份数提到 3（那要动 `kube-system` 的 device plugin 配置）或临时腾出一个单元。

**容量已经满了（重要）**：pp1 现在申请 4/4 个 GPU 单元。以后要再加任何吃 GPU 的服务，
必须先把 time-slicing 份数提高（见上节，改集群仓库的变量后重新下发）或关掉/搬走一个现有服务。

asr 是无状态 HTTP 服务（模型只读挂载、不写共享目录、不占固定端口以外的资源），2 个副本共用
同一个 RWX 模型 PVC，所以副本数可以直接加。

### 怎么验证「真的没掉线」

别看 pod 状态，要一边打流量一边滚动：

```bash
# 1) 每秒采一次 asr 的 Ready 位（证明任何时刻都至少 1 个 Ready）
for i in $(seq 1 300); do printf '%s %s\n' "$(date +%H:%M:%S)" \
  "$(kubectl -n pp1 get pods -l app=asr -o jsonpath='{range .items[*]}{.metadata.name}:{.status.containerStatuses[0].ready} {end}')" \
  >> /tmp/rollwatch.log; sleep 1; done &

# 2) 同时每 1.5 秒用真 Ogg 音频打一次 /human-to-brain（带 token；每次换一个临时 brain_id，
#    别用 codex 那个，免得把测试消息排进正在跑的会话）
#    → 统计成功/失败条数与单次耗时

# 3) 期间执行一次（或叠加一次真实镜像升级）
kubectl -n pp1 rollout restart deploy/asr
```

2026-10-21 实测（3 轮压测、4 次滚动：2 次 `rollout restart` + 2 次真实 image 字段变更）：

| 指标 | 结果 |
|---|---|
| 转写请求 | 274 次，成功 274，**失败 0（成功率 100%）** |
| 单次耗时 | 514 ~ 627 ms（滚动期间没有抖动） |
| Ready 采样 | 644 次（每秒一次），**`ready=0` 出现 0 次**，最少也是 1 个 Ready |
| 单次滚动耗时 | 约 80~100 秒（两个副本各重建一次，每次新副本约 40 秒完成加载+预热） |

顺带证明 brain 那条链没事：`verify-protocol.py` 全流程退出码 0，asr/tts 两个 ingress 的 `/health` 都是 200。

## 已修复：ASR 冷启动后的第一次转写会被判超时（2026-10-21，asr 镜像 0.1.2）

原现象：重启 asr 之后第一次 `/human-to-brain` 会先失败一次（客户端看到 502），紧接着重试就成功。
实测 ASR 服务端要 13.3s 才返回结果，而 brain 的 STT 调用超时是**写死在代码里的 13000 ms**：

```ts
// pp-brain-server apps/brains/src/brain-center.ts:248
const result = await callTranscript(req.audio, {
  signal: AbortSignal.any([signal, AbortSignal.timeout(13000)]),
});
```

全仓库只有这一处 13000，也没有对应环境变量，**没有开关可调**。

根因（实测结论，不是推测）：慢的不是「加载权重」——权重在 import 期就加载好了，
pod 日志里 `Loading ... / Ready.` 出现在 uvicorn 的 `Started server process` **之前**。
慢的是**第一次 transcribe 要付的一批一次性初始化**：transformers 首次 generate
（日志里紧挨着的 `Setting pad_token_id ...` 只在首次出现）、CUDA kernel / cuDNN 选择、
冷容器里的驱动与页缓存加载、以及第一次真正跑解码循环要占的显存和算子。

这笔开销是**按输入分批付出**的。在全新容器里逐段实测（`nerdctl run` 同一镜像）：

| 步骤 | 耗时 |
|---|---|
| 1.5 秒噪声（现场生成，模型输出为空） | 3.67s |
| 之后第一次真实语音（8 秒） | 再把剩下约 9s 付完（合计约 13s） |
| 再之后任何请求（8 秒 Ogg / 16.7 秒 Wav） | 0.68s / 1.08s |

所以只拿一小段噪声预热是不够的（只吃掉 4 秒），剩下的 9 秒照样落到用户第一句话上——
`pp1/asr:0.1.1` 就是这个失败的中间版本：第一次请求虽然不再 502，但 ASR 侧仍要 9.35s，离 13s 上限只剩 3.6 秒。

修复方式（只改我们自己的 `docker/asr/server.py`，末尾一行 `_warmup()` 调用 + Dockerfile 多
`COPY` 一个约 80KB 的 `docker/asr/warmup.ogg`）：在 uvicorn 开始监听之前，先拿一段**真实语音**
跑一次完整推理。那份语音用本项目自己的 TTS 合成（约 8 秒，内容无意义），随镜像分发。

为什么这样就够了：uvicorn 必须等模块 import 完才开始监听，k8s 又只在 `/health` 通得过之后
才把 pod 置为 Ready——**预热跑完之前 Service 一直没有 endpoint，brain 永远打不到冷的 asr**。
预热失败不拦启动，只在日志里留 `Warmup FAILED (...)` 并退回老行为。

这一点的直接证据是 pod 事件里那条 startup 探针失败：
`Startup probe failed: Get "http://<pod-ip>:8082/health": dial tcp ...: connection refused`
——预热期间端口根本没在监听，流量进不来的。

代价：pod 启动时间从约 30 秒变成约 45 秒（多出来的就是那 14 秒预热），`startupProbe`
给的是 10 分钟，余量充足。

验证（重启 pod 之后**立刻**用真音频打 `/human-to-brain`，每次都用全新的 brain_id）：

| 次第 | 修复前（0.1.0） | 修复后（0.1.2） |
|---|---|---|
| 1 | 502 / 客户端 13.010s（ASR 侧 13.307s） | 200 / 0.215s（ASR 侧 0.202s） |
| 2 | 502 / 13.044s | 200 / 0.175s |
| 3 | 502 / 13.044s | 200 / 0.181s |

（修复前那三次客户端 502 里只有一次真正打到 ASR，另两次死在 brain 的重试退避里，brain 日志可见
`DOMException [AbortError]: Delay was aborted`。）

补充证据：单独重启 pod 再立刻打（8 秒语音）三次全部 200，0.758s / 0.747s / 0.740s；
16.7 秒长语音 0.74s；`kubectl logs deploy/brain` 里 `转写失败` 计数为 0；
`verify-protocol.py` 全流程仍退出码 0。

回退：把 `04-asr.yaml` 的镜像改回 `pp1/asr:0.1.0` 即可，清单之外的东西都没动。

**这只解决「重启之后的第一句话」。** asr 重启的那几十秒本身仍然没有语音能力
（`Recreate` 策略，pod 不在时 brain 会立刻连接失败，而不是挂 13 秒）。
