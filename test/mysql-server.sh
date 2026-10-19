#!/bin/sh
# A throwaway MySQL 8 for the MySQL tests (test/drivers.js, main.js, tunnel.js and the end-to-end part of ui-driver.js).
# Downloads MySQL's official tarball once into $MYSQL_DIR (default: $TMPDIR/tinyarql-mysql, about 175 MB packed, 850 MB
# unpacked), listens on 127.0.0.1:33061 only, and installs nothing system-wide. macOS only.
#   test/mysql-server.sh start    first run downloads; every start rebuilds the data directory and the test users and tables
#   test/mysql-server.sh stop
#   test/mysql-server.sh status
set -e
VER=8.0.40
DIR="${MYSQL_DIR:-${TMPDIR:-/tmp}/tinyarql-mysql}"
case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64) PKG="mysql-$VER-macos14-x86_64" ;;
  Darwin-arm64)  PKG="mysql-$VER-macos14-arm64" ;;
  *) echo "mysql-server.sh supports macOS only; point the tests at any MySQL 8 on 127.0.0.1:33061 instead (see test/drivers.js)"; exit 1 ;;
esac
BASE="$DIR/$PKG"; BIN="$BASE/bin"; DATA="$DIR/data"; SOCK=/tmp/tinyarql-mysql.sock  # short path: unix socket paths are limited to ~100 bytes
alive() { [ -x "$BIN/mysqladmin" ] && "$BIN/mysqladmin" --no-defaults -uroot --socket="$SOCK" ping 2>/dev/null | grep -q alive; }

case "$1" in
  start)
    if alive; then echo "already running on 127.0.0.1:33061"; exit 0; fi
    mkdir -p "$DIR"
    if [ ! -d "$BASE" ]; then
      echo "downloading $PKG (about 175 MB)..."
      curl -fL --progress-bar -o "$DIR/$PKG.tar.gz" "https://cdn.mysql.com/archives/mysql-8.0/$PKG.tar.gz"
      tar xzf "$DIR/$PKG.tar.gz" -C "$DIR"
      rm -f "$DIR/$PKG.tar.gz"
    fi
    rm -rf "$DATA"
    # TLS: MySQL's own auto-generated certificate has no host name in it, so the tests use a self-signed one for localhost / 127.0.0.1
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
      -keyout "$DIR/server.key" -out "$DIR/server.crt" >/dev/null 2>&1
    "$BIN/mysqld" --no-defaults --initialize-insecure --datadir="$DATA" --basedir="$BASE" >/dev/null 2>&1
    ("$BIN/mysqld" --no-defaults --datadir="$DATA" --basedir="$BASE" --port=33061 --bind-address=127.0.0.1 --mysqlx=OFF \
       --ssl-ca="$DIR/server.crt" --ssl-cert="$DIR/server.crt" --ssl-key="$DIR/server.key" \
       --socket="$SOCK" --pid-file="$DIR/mysqld.pid" --log-error="$DIR/error.log" >/dev/null 2>&1 &)
    for i in $(seq 1 60); do sleep 1; alive && break; done
    alive || { echo "MySQL did not start; see $DIR/error.log"; exit 1; }
    "$BIN/mysql" --no-defaults -uroot --socket="$SOCK" <<'SQL'
create database testdb; create database otherdb;
create user 'tester'@'%' identified by 'secret';
create user 'native'@'%' identified with mysql_native_password by 'secret';
create user 'nopass'@'%' identified by '';
create user 'tlsonly'@'%' identified by 'secret' require ssl;
create user 'tlsnative'@'%' identified with mysql_native_password by 'secret' require ssl;
grant all on *.* to 'tester'@'%'; grant all on *.* to 'native'@'%'; grant all on *.* to 'nopass'@'%'; grant all on *.* to 'tlsonly'@'%'; grant all on *.* to 'tlsnative'@'%';
use testdb;
create table people(id int primary key auto_increment, name varchar(50), note text, born date, score decimal(10,2), flag tinyint(1), meta json, raw blob);
insert into people(name, note, born, score, flag, meta, raw) values
  ('ada','x','1815-12-10',12.50,1,'{"a": [1, 2]}', x'00ff10'),
  ('bob',null,null,null,0,null,null);
create view v as select id, name from people;
create table otherdb.elsewhere(k int);
SQL
    echo "MySQL $VER ready on 127.0.0.1:33061 (users tester/secret, native/secret, nopass/''; TLS on, certificate at $DIR/server.crt; tlsonly and tlsnative / secret accept TLS only)" ;;
  stop)
    if alive; then "$BIN/mysqladmin" --no-defaults -uroot --socket="$SOCK" shutdown && echo stopped; else echo "not running"; fi ;;
  status)
    if alive; then echo "running on 127.0.0.1:33061"; else echo "not running"; exit 1; fi ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
