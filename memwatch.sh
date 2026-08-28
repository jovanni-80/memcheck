#!/usr/bin/env bash
#
# memwatch.sh - sample system memory + top memory-consuming processes over time,
#               so an OOM/"virtual memory exhausted" failure can be traced back
#               to whatever was actually resident at that moment.
#
# The sampling loop deliberately spawns NO subprocesses: it reads /proc with
# bash builtins and sleeps on a fifo. When the machine is genuinely out of
# memory, fork() fails, so a monitor built on `ps`/`sleep` goes blind exactly
# when the interesting data appears.
#
# Usage:
#   ./memwatch.sh [-i SEC] [-n TOP] [-m MIN_RSS_MB] [-a PCT] [-o OUTDIR]
#   ./memwatch.sh --report OUTDIR
#
#   -i SEC        sample interval, default 2
#   -n TOP        processes logged per sample, default 15
#   -m MIN_RSS_MB ignore processes smaller than this, default 20
#   -a PCT        flag a sample "low" when MemAvailable < PCT% of MemTotal,
#                 default 10; low samples log -n 40 processes instead
#   -o OUTDIR     output directory, default ./memwatch-<timestamp>
#   --report DIR  analyze a previous run instead of recording
#
# Output (CSV, appended live, safe to read while running):
#   OUTDIR/system.csv  one row per sample: totals, available, swap, cgroup, load
#   OUTDIR/procs.csv   top-N rows per sample: pid, ppid, rss, vsz, comm, cmdline
#   OUTDIR/meta.txt    host/kernel/limits captured at start
#
set -uo pipefail

INTERVAL=2
TOP=15
TOP_LOW=40
MIN_RSS_KB=20480
ALERT_PCT=10
OUTDIR=""
PAGE_KB=4

# ---------------------------------------------------------------- args

while (($#)); do
    case $1 in
        -i) INTERVAL=$2; shift 2 ;;
        -n) TOP=$2; shift 2 ;;
        -m) MIN_RSS_KB=$(( $2 * 1024 )); shift 2 ;;
        -a) ALERT_PCT=$2; shift 2 ;;
        -o) OUTDIR=$2; shift 2 ;;
        --report) MODE=report; REPORT_DIR=${2:-}; shift 2 ;;
        -h|--help) sed -n '3,26p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
MODE=${MODE:-run}

# ---------------------------------------------------------------- report mode

report() {
    local dir=${1:-}
    [[ -n $dir && -f $dir/system.csv ]] || { echo "no system.csv found in '$dir'" >&2; exit 1; }

    echo "=== 10 lowest-memory moments ==="
    printf '%-21s %10s %10s %10s %8s\n' TIME AVAIL_GB SWAPFREE_GB COMMITTED_GB LOW
    tail -n +2 "$dir/system.csv" | sort -t, -k4 -n | head -10 |
        awk -F, '{printf "%-21s %10.2f %10.2f %10.2f %8s\n", $1, $4/1048576, $9/1048576, $10/1048576, $15}'

    local worst
    worst=$(tail -n +2 "$dir/system.csv" | sort -t, -k4 -n | head -1 | cut -d, -f2)
    echo
    echo "=== processes at the worst moment (epoch $worst) ==="
    printf '%8s %8s %10s %10s  %s\n' PID PPID RSS_MB VSZ_MB COMMAND
    awk -F, -v e="$worst" 'NR>1 && $1==e {
        cmd=$8; for(i=9;i<=NF;i++) cmd=cmd","$i; gsub(/^"|"$/,"",cmd)
        printf "%8s %8s %10.1f %10.1f  %.100s\n", $3, $4, $5/1024, $6/1024, cmd
    }' "$dir/procs.csv" | sort -k3 -nr

    echo
    echo "=== peak RSS ever seen, per process name ==="
    printf '%10s  %-24s %s\n' PEAK_MB NAME EXAMPLE
    awk -F, 'NR>1 {
        cmd=$8; for(i=9;i<=NF;i++) cmd=cmd","$i; gsub(/^"|"$/,"",cmd)
        if ($5+0 > m[$7]) { m[$7]=$5+0; ex[$7]=cmd }
    } END { for (k in m) printf "%10.1f  %-24s %.90s\n", m[k]/1024, k, ex[k] }' "$dir/procs.csv" |
        sort -k1 -nr | head -25

    echo
    echo "=== concurrency of the heaviest names over time (count, sum MB) ==="
    awk -F, 'NR>1 { c[$1" "$7]++; s[$1" "$7]+=$5 }
        END { for (k in c) { split(k,a," "); if (c[k] > mx[a[2]]) { mx[a[2]]=c[k]; ms[a[2]]=s[k]; at[a[2]]=a[1] } } }
        END { for (n in mx) printf "%-24s max %3d concurrent, %8.1f MB total, at epoch %s\n", n, mx[n], ms[n]/1024, at[n] }' \
        "$dir/procs.csv" | sort -k3 -nr | head -15
}

if [[ $MODE == report ]]; then
    report "${REPORT_DIR:-}"
    exit 0
fi

# ---------------------------------------------------------------- setup

if [[ -z $OUTDIR ]]; then
    printf -v _stamp '%(%Y%m%d-%H%M%S)T' -1
    OUTDIR="./memwatch-$_stamp"
fi
mkdir -p "$OUTDIR" || exit 1

# one-time forks, before the loop; getconf is worth it for correctness
PAGE_KB=$(( $(getconf PAGE_SIZE 2>/dev/null || echo 4096) / 1024 ))
(( PAGE_KB > 0 )) || PAGE_KB=4
MIN_RSS_PAGES=$(( MIN_RSS_KB / PAGE_KB ))

CG_CUR="" ; CG_MAX_FILE=""
if [[ -r /sys/fs/cgroup/memory.current ]]; then
    CG_CUR=/sys/fs/cgroup/memory.current; CG_MAX_FILE=/sys/fs/cgroup/memory.max
elif [[ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]]; then
    CG_CUR=/sys/fs/cgroup/memory/memory.usage_in_bytes
    CG_MAX_FILE=/sys/fs/cgroup/memory/memory.limit_in_bytes
fi

{
    echo "started:   $(date -Is)"
    echo "host:      $(uname -a)"
    echo "nproc:     $(nproc 2>/dev/null)"
    echo "page_kb:   $PAGE_KB"
    echo "interval:  ${INTERVAL}s   top: $TOP   min_rss: $((MIN_RSS_KB/1024))MB   alert: ${ALERT_PCT}%"
    echo "ulimit -v: $(ulimit -v)"
    echo "ulimit -m: $(ulimit -m)"
    echo "overcommit_memory: $(cat /proc/sys/vm/overcommit_memory 2>/dev/null)"
    echo "overcommit_ratio:  $(cat /proc/sys/vm/overcommit_ratio 2>/dev/null)"
    [[ -n $CG_MAX_FILE ]] && echo "cgroup limit: $(cat "$CG_MAX_FILE" 2>/dev/null) ($CG_MAX_FILE)"
    echo
    grep -E 'MemTotal|SwapTotal' /proc/meminfo
} > "$OUTDIR/meta.txt" 2>&1

exec 3>>"$OUTDIR/system.csv"
exec 4>>"$OUTDIR/procs.csv"
[[ -s $OUTDIR/system.csv ]] || printf 'iso,epoch,mem_total_kb,mem_avail_kb,mem_free_kb,buffers_kb,cached_kb,swap_total_kb,swap_free_kb,committed_kb,cgroup_cur_kb,cgroup_max_kb,load1,procs_running,low\n' >&3
[[ -s $OUTDIR/procs.csv ]]  || printf 'epoch,iso,pid,ppid,rss_kb,vsz_kb,comm,cmdline\n' >&4

# fork-free sleep: block on an empty fifo with a read timeout
HAVE_FIFO=0
_f=/tmp/memwatch.$$.fifo
if mkfifo -m 600 "$_f" 2>/dev/null; then
    exec 8<>"$_f" && HAVE_FIFO=1
    rm -f "$_f"
fi
nap() { if ((HAVE_FIFO)); then read -r -t "$1" -u 8 _ || :; else sleep "$1"; fi; }

# bash 4.4+ can read NUL-delimited cmdlines without forking
HAVE_MAPFILE_D=0
(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )) && HAVE_MAPFILE_D=1

MIN_AVAIL=999999999
MIN_AVAIL_AT=""
SAMPLES=0
RUNNING=1
trap 'RUNNING=0' INT TERM

finish() {
    exec 3>&- 4>&-
    echo
    echo "memwatch: $SAMPLES samples written to $OUTDIR"
    if [[ -n $MIN_AVAIL_AT ]]; then
        echo "memwatch: lowest MemAvailable was $(( MIN_AVAIL / 1024 )) MB at $MIN_AVAIL_AT"
    fi
    echo "memwatch: analyze with  $0 --report $OUTDIR"
}
trap finish EXIT

# ---------------------------------------------------------------- helpers

# ppid without forking; /proc/PID/stat comm field can contain spaces and ')'
get_ppid() {
    local line rest
    read -r line < "/proc/$1/stat" 2>/dev/null || { PPID_OUT=0; return; }
    rest=${line##*') '}
    set -- $rest
    PPID_OUT=${2:-0}
}

# ---------------------------------------------------------------- main loop

echo "memwatch: sampling every ${INTERVAL}s into $OUTDIR (Ctrl-C to stop)"

while (( RUNNING )); do
    printf -v epoch '%(%s)T' -1
    printf -v iso '%(%Y-%m-%dT%H:%M:%S)T' -1

    mem_total=0 mem_avail=0 mem_free=0 buffers=0 cached=0
    swap_total=0 swap_free=0 committed=0
    while IFS=$': \t' read -r key val _; do
        case $key in
            MemTotal)     mem_total=$val ;;
            MemFree)      mem_free=$val ;;
            MemAvailable) mem_avail=$val ;;
            Buffers)      buffers=$val ;;
            Cached)       cached=$val ;;
            SwapTotal)    swap_total=$val ;;
            SwapFree)     swap_free=$val ;;
            Committed_AS) committed=$val; break ;;
        esac
    done < /proc/meminfo
    (( mem_avail == 0 )) && mem_avail=$(( mem_free + buffers + cached ))

    cg_cur=0 cg_max=0
    if [[ -n $CG_CUR ]]; then
        read -r _v < "$CG_CUR" 2>/dev/null && cg_cur=$(( _v / 1024 ))
        read -r _v < "$CG_MAX_FILE" 2>/dev/null
        [[ $_v == max ]] && cg_max=0 || cg_max=$(( _v / 1024 ))
        # cgroup v1 reports PAGE_COUNTER_MAX rather than "max" for unlimited
        (( cg_max > mem_total * 4 )) && cg_max=0
    fi

    read -r l1 _ _ procs_stat _ < /proc/loadavg
    procs_running=${procs_stat%%/*}

    low=0
    (( mem_total > 0 && mem_avail * 100 / mem_total < ALERT_PCT )) && low=1
    (( cg_max > 0 && cg_cur * 100 / cg_max > 100 - ALERT_PCT )) && low=1

    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
        "$iso" "$epoch" "$mem_total" "$mem_avail" "$mem_free" "$buffers" "$cached" \
        "$swap_total" "$swap_free" "$committed" "$cg_cur" "$cg_max" "$l1" "$procs_running" "$low" >&3

    if (( mem_avail < MIN_AVAIL )); then MIN_AVAIL=$mem_avail; MIN_AVAIL_AT=$iso; fi

    # ---- top-N processes by RSS, selection-insert, no sort(1), no ps(1)
    want=$TOP
    (( low )) && want=$TOP_LOW
    t_rss=() t_pid=() t_vsz=()
    n=0 floor=0
    for statm in /proc/[0-9]*/statm; do
        read -r vsz rss _ < "$statm" 2>/dev/null || continue
        (( rss >= MIN_RSS_PAGES )) || continue
        (( n == want && rss <= floor )) && continue
        pid=${statm#/proc/}; pid=${pid%/statm}
        i=$n
        (( i == want )) && i=$(( want - 1 ))
        while (( i > 0 )) && (( rss > t_rss[i-1] )); do
            t_rss[i]=${t_rss[i-1]}; t_pid[i]=${t_pid[i-1]}; t_vsz[i]=${t_vsz[i-1]}
            (( i-- ))
        done
        t_rss[i]=$rss; t_pid[i]=$pid; t_vsz[i]=$vsz
        (( n < want )) && (( n++ ))
        floor=${t_rss[n-1]}
    done

    for (( i = 0; i < n; i++ )); do
        pid=${t_pid[i]}
        [[ -r /proc/$pid/statm ]] || continue      # exited mid-sample
        comm=""
        read -r comm < "/proc/$pid/comm" 2>/dev/null || comm="?"
        comm=${comm//,/_}
        cmd=""
        if (( HAVE_MAPFILE_D )); then
            mapfile -d '' -t _args < "/proc/$pid/cmdline" 2>/dev/null
            cmd="${_args[*]}"
        fi
        [[ -z $cmd ]] && cmd="[$comm]"
        cmd=${cmd//$'\n'/ }
        cmd=${cmd//$'\t'/ }
        cmd=${cmd//\"/\'}
        (( ${#cmd} > 300 )) && cmd="${cmd:0:300}..."
        get_ppid "$pid"
        printf '%s,%s,%s,%s,%s,%s,%s,"%s"\n' \
            "$epoch" "$iso" "$pid" "$PPID_OUT" \
            "$(( t_rss[i] * PAGE_KB ))" "$(( t_vsz[i] * PAGE_KB ))" "$comm" "$cmd" >&4
    done

    (( SAMPLES++ ))
    nap "$INTERVAL"
done
