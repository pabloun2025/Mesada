#!/usr/bin/env bash
# Fija los artefactos de Kokoro publicados para kokoro-onnx.
set -euo pipefail
cd "$(dirname "$0")"
model_dir="${MESADA_MODELOS:-$PWD/modelos}"
mkdir -p "$model_dir"
base=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
get_model() {
  local name="$1" digest="$2"
  if (cd "$model_dir" && printf '%s  %s\n' "$digest" "$name" | sha256sum -c --status); then
    return
  fi
  local download
  download="$(mktemp "$model_dir/.download.XXXXXX")"
  if curl --fail --silent --show-error --location --output "$download" "$base/$name" &&
     printf '%s  %s\n' "$digest" "$download" | sha256sum -c --status; then
    mv -f "$download" "$model_dir/$name"
  else
    rm -f "$download"
    return 1
  fi
}
get_model kokoro-v1.0.onnx 7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5
get_model voices-v1.0.bin bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d
