#!/bin/sh
# Move profiles and settings from tui-browser's XDG directories to tawb's.
set -eu

data_home=${XDG_DATA_HOME:-"${HOME:?HOME is not set}/.local/share"}
config_home=${XDG_CONFIG_HOME:-"${HOME:?HOME is not set}/.config"}

old_data=$data_home/tui-browser
new_data=$data_home/tawb
old_config=$config_home/tui-browser
new_config=$config_home/tawb

check_destination() {
  old=$1
  new=$2

  [ -e "$old" ] || return 0
  [ ! -e "$new" ] && return 0
  if [ -d "$new" ] && [ -z "$(find "$new" -mindepth 1 -print -quit)" ]; then
    return 0
  fi

  echo "Cannot migrate $old: $new already exists and is not empty." >&2
  return 1
}

move_directory() {
  old=$1
  new=$2

  if [ ! -e "$old" ]; then
    echo "Nothing to migrate from $old."
    return
  fi

  if [ -d "$new" ]; then
    rmdir "$new"
  fi
  mkdir -p "$(dirname "$new")"
  mv "$old" "$new"
  echo "Moved $old to $new."
}

# Check both destinations before moving either, so a conflict cannot leave a
# profile migrated while its settings remain under the old name.
check_destination "$old_data" "$new_data"
check_destination "$old_config" "$new_config"

move_directory "$old_data" "$new_data"
move_directory "$old_config" "$new_config"
