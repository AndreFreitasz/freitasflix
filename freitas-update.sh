#!/bin/sh
# Baixa o último build do Freitas+ e instala na pasta montada no container do Jellyfin.
# Uso no servidor:  sudo sh freitas-update.sh
set -e

DEST="${DEST:-/DATA/AppData/jellyfin/freitas-web}"
URL="https://github.com/AndreFreitasz/freitasflix/releases/download/freitas-latest/freitas-web.tar.gz"
TMP="$(mktemp -d)"

echo "Baixando build..."
curl -fL "$URL" -o "$TMP/freitas-web.tar.gz"

echo "Instalando em $DEST..."
mkdir -p "$DEST"
rm -rf "${DEST:?}"/*
tar -xzf "$TMP/freitas-web.tar.gz" -C "$DEST"
rm -rf "$TMP"

CONTAINER="$(docker ps --format '{{.Names}}' | grep -i jellyfin | head -n1)"
if [ -n "$CONTAINER" ]; then
    echo "Reiniciando $CONTAINER..."
    docker restart "$CONTAINER" >/dev/null
fi
echo "Pronto! Atualize a página do Jellyfin (Ctrl+F5)."
