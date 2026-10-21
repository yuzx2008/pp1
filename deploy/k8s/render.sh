#!/usr/bin/env bash
# 用途：把 deploy/k8s/*.yaml 里的 @@占位符@@ 替换成本地实际值，生成可直接 apply 的清单。
#
#   cd deploy/k8s
#   cp local.env.example local.env    # 第一次：按自己的环境填
#   ./render.sh                       # 结果在 rendered/
#   kubectl apply -f rendered/
#
# 值来自 local.env（被 .gitignore 忽略）。已经存在的同名环境变量优先于文件里的值，
# 临时换一两个值不必改文件：
#   IMAGE_REGISTRY=registry.example.com:5000 ./render.sh
#
# 缺失的值、以及渲染后仍然残留的 @@占位符@@ 都会报错退出，不会产出半成品清单。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${PP1_ENV_FILE:-$here/local.env}"
out_dir="$here/rendered"
required=(IMAGE_REGISTRY STORAGE_CLASS INGRESS_DOMAIN CLUSTER_ISSUER WEIGHTS_DIR)

if [ ! -f "$env_file" ]; then
  echo "找不到 $env_file" >&2
  echo "先执行：cp '$here/local.env.example' '$env_file' 然后按自己的环境填写。" >&2
  exit 1
fi

# 读 local.env：只认 KEY=VALUE，忽略注释行与空行；已存在的环境变量优先。
# 用 declare 而不是 eval 赋值：值里带 $、反引号、| 时不会被 shell 再解释一遍
# （eval 会把它当命令跑，反而让后面的校验没有机会报错）。
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  key="${line%%=*}"
  case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
  if [ -z "${!key:-}" ]; then
    declare -g "$key=${line#*=}"
  fi
done <"$env_file"

missing=()
for key in "${required[@]}"; do
  if [ -z "${!key:-}" ]; then
    missing+=("$key")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "$env_file 里缺少：${missing[*]}" >&2
  exit 1
fi

sed_scripts=()
for key in "${required[@]}"; do
  val="${!key}"
  # 这些字符会破坏 sed 表达式或让替换结果不可预期，宁可报错也不要生成坏清单。
  case "$val" in
    *"|"* | *"&"* | *'\'*)
      echo "$env_file 里的 $key 含有 | & \\ 之一，请换掉" >&2
      exit 1
      ;;
  esac
  sed_scripts+=(-e "s|@@$key@@|$val|g")
done

shopt -s nullglob
manifests=("$here"/[0-9][0-9]-*.yaml)
if [ "${#manifests[@]}" -eq 0 ]; then
  echo "$here 下没有找到 NN-*.yaml 清单" >&2
  exit 1
fi

mkdir -p "$out_dir"
rendered=()
for src in "${manifests[@]}"; do
  name="$(basename "$src")"
  sed "${sed_scripts[@]}" "$src" >"$out_dir/$name"
  if grep -q '@@' "$out_dir/$name"; then
    echo "$name 渲染后仍有未替换的占位符：" >&2
    grep -o '@@[A-Za-z0-9_]*@@' "$out_dir/$name" | sort -u >&2
    exit 1
  fi
  rendered+=("$name")
done

echo "已按 $env_file 渲染 ${#rendered[@]} 个清单到 $out_dir："
printf '  %s\n' "${rendered[@]}"
echo "下一个命令：kubectl apply -f $out_dir"
