#!/bin/sh
# A throwaway PostgreSQL for the tests (test/drivers.js, main.js, tunnel.js). Unlike the MySQL script this downloads nothing: it
# uses a PostgreSQL you already have installed (Homebrew's postgresql@NN, Postgres.app, or anything with initdb on your PATH).
# It listens on 127.0.0.1:54329 only, keeps its data in $PG_DIR (default: $TMPDIR/tinyarql-postgres) and touches nothing else.
#   test/postgres-server.sh start    every start rebuilds the data directory, the test user and the tables
#   test/postgres-server.sh stop
#   test/postgres-server.sh status
# Override the binaries with PG_BIN=/path/to/postgres/bin if it cannot find yours.
set -e
PORT=54329
DIR="${PG_DIR:-${TMPDIR:-/tmp}/tinyarql-postgres}"
DATA="$DIR/data"

find_bin() {
  [ -n "$PG_BIN" ] && { echo "$PG_BIN"; return; }
  if command -v initdb >/dev/null 2>&1; then dirname "$(command -v initdb)"; return; fi
  for d in $(ls -d /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin /Applications/Postgres.app/Contents/Versions/*/bin /usr/lib/postgresql/*/bin 2>/dev/null | sort -r); do
    [ -x "$d/initdb" ] && { echo "$d"; return; }
  done
}
BIN="$(find_bin)"
[ -n "$BIN" ] && [ -x "$BIN/initdb" ] || { echo "no PostgreSQL found (need initdb, pg_ctl, psql). Install one, for example: brew install postgresql@15, or set PG_BIN"; exit 1; }
alive() { "$BIN/pg_isready" -h 127.0.0.1 -p $PORT -q 2>/dev/null; }

case "$1" in
  start)
    if alive; then echo "already running on 127.0.0.1:$PORT"; exit 0; fi
    mkdir -p "$DIR"; rm -rf "$DATA"
    printf 'secret' > "$DIR/pw"
    "$BIN/initdb" -D "$DATA" -U tester --pwfile="$DIR/pw" --auth=scram-sha-256 -E UTF8 >/dev/null
    rm -f "$DIR/pw"
    # unix_socket_directories='' : socket paths are limited to ~100 bytes and TMPDIR paths are long, so listen on TCP only
    "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" -l "$DIR/server.log" -w start >/dev/null \
      || { echo "PostgreSQL did not start; see $DIR/server.log"; exit 1; }
    PGPASSWORD=secret "$BIN/psql" -h 127.0.0.1 -p $PORT -U tester -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
create table people(id serial primary key, name text, note text);
insert into people(name, note) values ('ada', 'x'), ('bob', null);
create view v as select * from people;
SQL
    echo "PostgreSQL ready on 127.0.0.1:$PORT (user tester / password secret, database postgres)" ;;
  stop)
    if alive; then "$BIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null && echo stopped; else echo "not running"; fi ;;
  status)
    if alive; then echo "running on 127.0.0.1:$PORT"; else echo "not running"; exit 1; fi ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
