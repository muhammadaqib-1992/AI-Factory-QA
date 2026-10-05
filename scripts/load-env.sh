# shellcheck shell=bash
# Sourced by the other scripts:  . scripts/load-env.sh
#
# Exports KEY=VALUE pairs from the repo's .env WITHOUT running it through the shell, so
# values containing <, >, $, spaces or quotes are taken literally and Windows (CRLF)
# line endings are tolerated. Variables already set in the environment win.

_env_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
if [ ! -f "$_env_file" ]; then
  echo "No .env file. Create it first:  cp .env.example .env && chmod 600 .env" >&2
  return 1  # this file is always sourced
fi

while IFS= read -r _line || [ -n "$_line" ]; do
  _line="${_line%$'\r'}"
  [[ "$_line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$_line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
  _key="${BASH_REMATCH[2]}"
  _val="${BASH_REMATCH[3]}"
  if [[ "$_val" =~ ^\"(.*)\"[[:space:]]*$ ]] || [[ "$_val" =~ ^\'(.*)\'[[:space:]]*$ ]]; then
    _val="${BASH_REMATCH[1]}"
  else
    _val="${_val%%[[:space:]]#*}"                 # trailing " # comment"
    _val="${_val%"${_val##*[![:space:]]}"}"        # trailing spaces
  fi
  if [ -z "${!_key+x}" ] || [ -z "${!_key}" ]; then
    export "$_key=$_val"
  fi
done < "$_env_file"
unset _env_file _line _key _val
