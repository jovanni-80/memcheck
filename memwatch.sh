#!/usr/bin/env bash
#
# memwatch.sh - sample system memory + every resident process over time, so an
#               OOM/"virtual memory exhausted" failure can be traced back to
#               whatever was actually holding memory at that moment.
#
# The sampling loop deliberately spawns NO subprocesses: it reads /proc with
# bash builtins and sleeps on a fifo. When the machine is genuinely out of
# memory, fork() fails, so a monitor built on `ps`/`sleep` goes blind exactly
# when the interesting data appears.
#
# Usage:
#   ./memwatch.sh [-i SEC] [-m MIN_RSS_MB] [-n CAP] [-a PCT] [-P] [-o OUTDIR]
#   ./memwatch.sh --report OUTDIR
#
#   -i SEC        sample interval, default 2
#   -m MIN_RSS_MB only log processes at or above this RSS, default 0 (all of
#                 them; kernel threads have no RSS so they never appear)
#   -n CAP        log only the CAP largest processes per sample, default 0 = no
#                 cap. Use this only if the log is growing too fast to keep.
#   -a PCT        flag a sample "low" when MemAvailable < PCT% of MemTotal,
#                 default 10
#   -P            record PSS instead of RSS by reading smaps_rollup. Slower
#                 (the kernel walks page tables per process) but shared pages
#                 are divided between sharers instead of counted once each, so
#                 the per-process figures actually sum to something meaningful.
#   -o OUTDIR     output directory, default ./memwatch-<timestamp>
#   --report DIR  analyze a previous run instead of recording
#
# Output (CSV, appended live, safe to read while running):
#   OUTDIR/system.csv  per sample: totals, available, swap, cgroup, load, and
#                      the kernel-side breakdown (shmem/tmpfs, slab, page
#                      tables) that explains memory belonging to no process
#   OUTDIR/procs.csv   per sample, one row per process, tagged with the build
#                      step it belongs to (compile/link/archive/...).
#                      comm/ppid/role/cmdline are written only the first time a
#                      pid is seen; later rows leave them empty. Fill forward.
#   OUTDIR/meta.txt    host/kernel/limits/tmpfs captured at start
#
set -uo pipefail

INTERVAL=2
MIN_RSS_KB=0
CAP=0
ALERT_PCT=10
USE_PSS=0
OUTDIR=""
PAGE_KB=4

# ---------------------------------------------------------------- args

while (($#)); do
    case $1 in
        -i) INTERVAL=$2; shift 2 ;;
        -m) MIN_RSS_KB=$(( $2 * 1024 )); shift 2 ;;
        -n) CAP=$2; shift 2 ;;
        -a) ALERT_PCT=$2; shift 2 ;;
        -P) USE_PSS=1; shift ;;
        -o) OUTDIR=$2; shift 2 ;;
        --report) MODE=report; REPORT_DIR=${2:-}; shift 2 ;;
        -h|--help) sed -n '3,37p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
MODE=${MODE:-run}

# ---------------------------------------------------------------- report mode

report() {
    local dir=${1:-}
    [[ -n $dir && -f $dir/system.csv ]] || { echo "no system.csv found in '$dir'" >&2; exit 1; }

    echo "=== 10 lowest-memory moments ==="
    printf '%-21s %9s %9s %9s %9s %9s %5s\n' TIME AVAIL_GB SWAP_GB SHMEM_GB SLAB_GB PGTBL_GB LOW
    tail -n +2 "$dir/system.csv" | sort -t, -k4 -n | head -10 |
        awk -F, '{printf "%-21s %9.2f %9.2f %9.2f %9.2f %9.2f %5s\n",
            $1, $4/1048576, ($8-$9)/1048576, $16/1048576, $17/1048576, $20/1048576, $15}'

    local worst
    worst=$(tail -n +2 "$dir/system.csv" | sort -t, -k4 -n | head -1 | cut -d, -f2)

    echo
    echo "=== where the memory was at the tightest moment (epoch $worst) ==="
    awk -F, -v e="$worst" 'NR>1 && $2==e {
        used = $3 - $4
        printf "  in use              %9.2f GB\n", used/1048576
        printf "    tmpfs / shmem     %9.2f GB\n", $16/1048576
        printf "    kernel slab       %9.2f GB   (unreclaimable %.2f GB)\n", $17/1048576, $19/1048576
        printf "    page tables       %9.2f GB\n", $20/1048576
        printf "    kernel stacks     %9.2f GB\n", $21/1048576
        printf "    hugetlb           %9.2f GB\n", $24/1048576
        printf "    anon pages        %9.2f GB\n", $22/1048576
        printf "  processes logged    %9s\n", $25
        exit
    }' "$dir/system.csv"

    if [[ -f $dir/procs.csv ]]; then
        awk -F, -v e="$worst" 'NR>1 && $1==e { s += $3 } END {
            printf "  sum of process RSS  %9.2f GB\n", s/1048576
            print  "  (RSS counts shared pages once per process, so this can overshoot;"
            print  "   re-run with -P for PSS if the two do not reconcile)"
        }' "$dir/procs.csv"

        echo
        echo "=== 25 largest processes at that moment ==="
        printf '%8s %10s %10s  %s\n' PID RSS_MB VSZ_MB COMMAND
        awk -F, -v e="$worst" '
            NR>1 && $5 != "" { name[$2] = $5; cmd[$2] = $8 }
            NR>1 && $1 == e  { printf "%8s %10.1f %10.1f  %s %.90s\n", $2, $3/1024, $4/1024, name[$2], cmd[$2] }
        ' "$dir/procs.csv" | sort -k2 -nr | head -25

        echo
        echo "=== peak RSS ever seen, per process name ==="
        printf '%10s %6s  %s\n' PEAK_MB MAX_N NAME
        awk -F, '
            NR>1 && $5 != "" { name[$2] = $5 }
            NR>1 { k = $1 SUBSEP name[$2]; sum[k] += $3; cnt[k]++ }
            END { for (k in sum) { split(k, a, SUBSEP)
                    if (sum[k] > peak[a[2]]) peak[a[2]] = sum[k]
                    if (cnt[k] > maxn[a[2]]) maxn[a[2]] = cnt[k] }
                  for (nm in peak) printf "%10.1f %6d  %s\n", peak[nm]/1024, maxn[nm], nm }
        ' "$dir/procs.csv" | sort -k1 -nr | head -25
        echo
        echo "=== memory per build step ==="
        echo "Peak RSS reached by each individual process, grouped by what it was doing."
        echo "Size job pools off p95, not the mean — the mean hides the file that kills you."
        printf '%-10s %7s %9s %9s %9s %9s\n' STEP PROCS MEAN_MB P50_MB P95_MB MAX_MB
        awk -F, '
            NR>1 {
                pid = $2
                if ($5 != "") { gen[pid]++; role[pid] = ($7 == "" ? "other" : $7) }
                key = pid ":" gen[pid]
                if ($3 + 0 > peak[key]) peak[key] = $3 + 0
                who[key] = role[pid]
            }
            END { for (k in peak) print who[k], peak[k] }
        ' "$dir/procs.csv" | sort -k1,1 -k2,2n | awk '
            { v[$1, ++c[$1]] = $2 + 0; s[$1] += $2 }
            END {
                for (r in c) {
                    n = c[r]
                    p50 = v[r, int((n + 1) / 2)]
                    p95 = v[r, int(n * 0.95) < 1 ? 1 : int(n * 0.95)]
                    printf "%-10s %7d %9.1f %9.1f %9.1f %9.1f\n",
                        r, n, s[r] / n / 1024, p50 / 1024, p95 / 1024, v[r, n] / 1024
                }
            }' | sort -k5 -nr

        echo
        echo "=== how much of the machine each step held at once ==="
        printf '%-10s %13s %13s %9s %9s\n' STEP MEAN_TOTAL_GB PEAK_TOTAL_GB MEAN_N PEAK_N
        awk -F, '
            NR>1 {
                pid = $2
                if ($5 != "") role[pid] = ($7 == "" ? "other" : $7)
                r = role[pid]
                sum[$1, r] += $3; cnt[$1, r]++
                seen[$1] = 1; roles[r] = 1
            }
            END {
                for (e in seen) samples++
                for (k in sum) {
                    split(k, a, SUBSEP); r = a[2]
                    tot[r] += sum[k]; num[r] += cnt[k]
                    if (sum[k] > pt[r]) pt[r] = sum[k]
                    if (cnt[k] > pn[r]) pn[r] = cnt[k]
                }
                for (r in roles)
                    printf "%-10s %13.2f %13.2f %9.1f %9d\n",
                        r, tot[r] / samples / 1048576, pt[r] / 1048576,
                        num[r] / samples, pn[r]
            }' "$dir/procs.csv" | sort -k3 -nr
    fi
}

if [[ $MODE == report ]]; then
    report "${REPORT_DIR:-}"
    exit 0
fi

# ---------------------------------------------------------------- setup

if [[ -z $OUTDIR ]]; then
    printf -v _stamp '%(%Y%m%d-%H%M%S)T' -1
    OUTDIR="/tmp/memwatch-$_stamp"
fi
mkdir -p "$OUTDIR" || exit 1

# one-time forks, before the loop
PAGE_KB=$(( $(getconf PAGE_SIZE 2>/dev/null || echo 4096) / 1024 ))
(( PAGE_KB > 0 )) || PAGE_KB=4
MIN_RSS_PAGES=$(( MIN_RSS_KB / PAGE_KB ))

if (( USE_PSS )) && [[ ! -r /proc/self/smaps_rollup ]]; then
    echo "memwatch: no smaps_rollup on this kernel, falling back to RSS" >&2
    USE_PSS=0
fi

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
    echo "interval:  ${INTERVAL}s   min_rss: $((MIN_RSS_KB/1024))MB   cap: $CAP   alert: ${ALERT_PCT}%"
    echo "metric:    $( ((USE_PSS)) && echo PSS || echo RSS )"
    echo "ulimit -v: $(ulimit -v)"
    echo "ulimit -m: $(ulimit -m)"
    echo "overcommit_memory: $(cat /proc/sys/vm/overcommit_memory 2>/dev/null)"
    echo "overcommit_ratio:  $(cat /proc/sys/vm/overcommit_ratio 2>/dev/null)"
    [[ -n $CG_MAX_FILE ]] && echo "cgroup limit: $(cat "$CG_MAX_FILE" 2>/dev/null) ($CG_MAX_FILE)"
    echo
    echo "--- tmpfs mounts at start (these hold memory no process owns) ---"
    df -h -t tmpfs 2>/dev/null
    echo
    echo "--- meminfo at start ---"
    cat /proc/meminfo 2>/dev/null
} > "$OUTDIR/meta.txt" 2>&1

exec 3>>"$OUTDIR/system.csv"
exec 4>>"$OUTDIR/procs.csv"
[[ -s $OUTDIR/system.csv ]] || printf 'iso,epoch,mem_total_kb,mem_avail_kb,mem_free_kb,buffers_kb,cached_kb,swap_total_kb,swap_free_kb,committed_kb,cgroup_cur_kb,cgroup_max_kb,load1,procs_running,low,shmem_kb,slab_kb,sreclaimable_kb,sunreclaim_kb,pagetables_kb,kernelstack_kb,anon_kb,mapped_kb,hugetlb_kb,procs_logged,metric\n' >&3
[[ -s $OUTDIR/procs.csv ]]  || printf 'epoch,pid,rss_kb,vsz_kb,comm,ppid,role,cmdline\n' >&4

# fork-free sleep: block on an empty fifo with a read timeout
HAVE_FIFO=0
_f=/tmp/memwatch.$$.fifo
if mkfifo -m 600 "$_f" 2>/dev/null; then
    exec 8<>"$_f" && HAVE_FIFO=1
    rm -f "$_f"
fi
nap() { if ((HAVE_FIFO)); then read -r -t "$1" -u 8 _ || :; else sleep "$1"; fi; }

HAVE_MAPFILE_D=0
(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )) && HAVE_MAPFILE_D=1

declare -A SEEN   # pid -> comm, so a pid's identity is written just once
declare -A ROLE   # pid -> compile/link/archive/..., inherited by children

MIN_AVAIL=999999999
MIN_AVAIL_AT=""
SAMPLES=0
ROWS=0
RUNNING=1
trap 'RUNNING=0' INT TERM

finish() {
    exec 3>&- 4>&-
    echo
    echo "memwatch: $SAMPLES samples, $ROWS process rows -> $OUTDIR"
    [[ -n $MIN_AVAIL_AT ]] &&
        echo "memwatch: lowest MemAvailable was $(( MIN_AVAIL / 1024 )) MB at $MIN_AVAIL_AT"
    echo "memwatch: analyze with  $0 --report $OUTDIR"
}
trap finish EXIT

# ---------------------------------------------------------------- helpers

# ppid without forking; the comm field in /proc/PID/stat may contain ') '
get_ppid() {
    local line rest
    read -r line < "/proc/$1/stat" 2>/dev/null || { PPID_OUT=0; return; }
    rest=${line##*') '}
    set -- $rest
    PPID_OUT=${2:-0}
}

# Work out what build step a process belongs to.
#
# `comm` is capped at 15 characters by the kernel, so a toolchain-prefixed
# binary like x86_64-linux-gnu-g++-13 arrives truncated and unrecognisable.
# argv[0] is not truncated, so match on that first. A gcc/g++ driver is a
# compile or a link depending only on its arguments, and the helpers it forks
# (cc1plus, collect2, ld, lto1) inherit the answer through their parent.
classify() {
    local comm=$1 cmd=$2 ppid=$3 prog spaced
    prog=${cmd%% *}
    prog=${prog##*/}

    case $prog in
        cc1plus|cc1|cc1obj|cc1objplus|f951) ROLE_OUT=compile; return ;;
        lto1|lto-wrapper)                   ROLE_OUT=link;    return ;;
        collect2|ld|ld.bfd|ld.gold|ld.lld|lld|gold|mold|wild) ROLE_OUT=link; return ;;
        ar|ranlib|llvm-ar|llvm-ranlib)      ROLE_OUT=archive; return ;;
        as|gas|llvm-as)                     ROLE_OUT=assemble; return ;;
        strip|objcopy|dsymutil)             ROLE_OUT=postlink; return ;;
    esac
    case $comm in
        cc1plus|cc1|lto1) ROLE_OUT=compile; [[ $comm == lto1 ]] && ROLE_OUT=link; return ;;
        collect2|ld|ld.bfd|ld.gold|ld.lld|lld|mold) ROLE_OUT=link; return ;;
    esac

    # a driver: the arguments decide. pad so " -c " matches at either end.
    case $prog in
        *gcc*|*g++*|*clang*|*c++|cc|ccache|distcc|sccache|*-ld|ld*)
            spaced=" $cmd "
            case $spaced in
                *" -c "*|*" -S "*|*" -fsyntax-only "*) ROLE_OUT=compile; return ;;
                *" -E "*)                              ROLE_OUT=preprocess; return ;;
                *" -shared "*|*" -Wl,"*|*" -o "*.so*|*" -o "*.a\ *|*.o\ *)
                                                       ROLE_OUT=link; return ;;
            esac
            ;;
    esac

    # a wrapper or interpreter may sit in front of the real tool: ccache,
    # distcc, or a shell/python wrapper script. Look a few arguments in.
    set -f
    local tok i=0
    for tok in $cmd; do
        (( i++ > 4 )) && break
        tok=${tok##*/}
        case $tok in
            cc1plus|cc1|cc1obj|cc1objplus|f951) set +f; ROLE_OUT=compile; return ;;
            lto1)                               set +f; ROLE_OUT=link;    return ;;
            collect2|ld|ld.bfd|ld.gold|ld.lld|lld|mold|gold) set +f; ROLE_OUT=link; return ;;
            ar|ranlib|llvm-ar)                  set +f; ROLE_OUT=archive; return ;;
            as|gas)                             set +f; ROLE_OUT=assemble; return ;;
        esac
    done
    set +f

    # otherwise take the parent's step, so wrappers and shells don't orphan
    # their children into "other"
    case ${ROLE[$ppid]:-} in
        compile|link|archive|assemble|postlink) ROLE_OUT=${ROLE[$ppid]}; return ;;
    esac
    ROLE_OUT=other
}

# Append one process row to $batch. comm/ppid/cmdline are written only when the
# pid is new (or has been recycled onto a different program), which is most of
# the row width — without it, logging every process triples the log size.
emit_row() {
    local pid=$1 rss_pages=$2 vsz_pages=$3
    local kb comm cmd line key val

    if (( USE_PSS )); then
        kb=0
        while IFS=$': \t' read -r key val _; do
            [[ $key == Pss ]] && { kb=$val; break; }
        done < "/proc/$pid/smaps_rollup" 2>/dev/null
        (( kb == 0 )) && kb=$(( rss_pages * PAGE_KB ))
    else
        kb=$(( rss_pages * PAGE_KB ))
    fi

    comm=""
    read -r comm < "/proc/$pid/comm" 2>/dev/null || return
    comm=${comm//,/_}

    if [[ ${SEEN[$pid]:-} == "$comm" ]]; then
        printf -v line '%s,%s,%s,%s,,,,\n' "$epoch" "$pid" "$kb" "$(( vsz_pages * PAGE_KB ))"
    else
        SEEN[$pid]=$comm
        cmd=""
        if (( HAVE_MAPFILE_D )); then
            mapfile -d '' -t _args < "/proc/$pid/cmdline" 2>/dev/null
            cmd="${_args[*]}"
        fi
        [[ -z $cmd ]] && cmd="[$comm]"
        cmd=${cmd//$'\n'/ }
        cmd=${cmd//$'\t'/ }
        cmd=${cmd//\"/\'}
        (( ${#cmd} > 2048 )) && cmd="${cmd:0:2048}..."
        get_ppid "$pid"
        classify "$comm" "$cmd" "$PPID_OUT"
        ROLE[$pid]=$ROLE_OUT
        printf -v line '%s,%s,%s,%s,%s,%s,%s,"%s"\n' \
            "$epoch" "$pid" "$kb" "$(( vsz_pages * PAGE_KB ))" "$comm" "$PPID_OUT" "$ROLE_OUT" "$cmd"
    fi

    batch+=$line
    (( count++ ))
}

# ---------------------------------------------------------------- main loop

echo "memwatch: sampling every ${INTERVAL}s into $OUTDIR (Ctrl-C to stop)"
(( CAP )) && echo "memwatch: capped at $CAP processes per sample"

while (( RUNNING )); do
    printf -v epoch '%(%s)T' -1
    printf -v iso '%(%Y-%m-%dT%H:%M:%S)T' -1

    mem_total=0 mem_avail=0 mem_free=0 buffers=0 cached=0
    swap_total=0 swap_free=0 committed=0 shmem=0 slab=0 sreclaim=0
    sunreclaim=0 pagetables=0 kstack=0 anon=0 mapped=0 hugetlb=0
    while IFS=$': \t' read -r key val _; do
        case $key in
            MemTotal)     mem_total=$val ;;
            MemFree)      mem_free=$val ;;
            MemAvailable) mem_avail=$val ;;
            Buffers)      buffers=$val ;;
            Cached)       cached=$val ;;
            SwapTotal)    swap_total=$val ;;
            SwapFree)     swap_free=$val ;;
            Committed_AS) committed=$val ;;
            Shmem)        shmem=$val ;;
            Slab)         slab=$val ;;
            SReclaimable) sreclaim=$val ;;
            SUnreclaim)   sunreclaim=$val ;;
            PageTables)   pagetables=$val ;;
            KernelStack)  kstack=$val ;;
            AnonPages)    anon=$val ;;
            Mapped)       mapped=$val ;;
            Hugetlb)      hugetlb=$val ;;
        esac
    done < /proc/meminfo
    (( mem_avail == 0 )) && mem_avail=$(( mem_free + buffers + cached ))

    cg_cur=0 cg_max=0
    if [[ -n $CG_CUR ]]; then
        read -r _v < "$CG_CUR" 2>/dev/null && cg_cur=$(( _v / 1024 ))
        read -r _v < "$CG_MAX_FILE" 2>/dev/null
        [[ $_v == max ]] && cg_max=0 || cg_max=$(( _v / 1024 ))
        (( cg_max > mem_total * 4 )) && cg_max=0   # v1 sentinel for "no limit"
    fi

    read -r l1 _ _ procs_stat _ < /proc/loadavg
    procs_running=${procs_stat%%/*}

    low=0
    (( mem_total > 0 && mem_avail * 100 / mem_total < ALERT_PCT )) && low=1
    (( cg_max > 0 && cg_cur * 100 / cg_max > 100 - ALERT_PCT )) && low=1

    # ---- every process with resident memory, batched into one write
    batch=""
    count=0
    if (( CAP )); then
        c_rss=() c_pid=() c_vsz=()
        floor=0 n=0
    fi

    for statm in /proc/[0-9]*/statm; do
        [-r "$statm" ] || continue
        read -r vsz rss _ < "$statm" 2>/dev/null || continue
        (( rss > 0 && rss >= MIN_RSS_PAGES )) || continue
        pid=${statm#/proc/}; pid=${pid%/statm}

        if (( CAP )); then
            (( n == CAP && rss <= floor )) && continue
            i=$n
            (( i == CAP )) && i=$(( CAP - 1 ))
            while (( i > 0 )) && (( rss > c_rss[i-1] )); do
                c_rss[i]=${c_rss[i-1]}; c_pid[i]=${c_pid[i-1]}; c_vsz[i]=${c_vsz[i-1]}
                (( i-- ))
            done
            c_rss[i]=$rss; c_pid[i]=$pid; c_vsz[i]=$vsz
            (( n < CAP )) && (( n++ ))
            floor=${c_rss[n-1]}
            continue
        fi

        emit_row "$pid" "$rss" "$vsz"
    done

    if (( CAP )); then
        for (( i = 0; i < n; i++ )); do
            emit_row "${c_pid[i]}" "${c_rss[i]}" "${c_vsz[i]}"
        done
    fi

    [[ -n $batch ]] && printf '%s' "$batch" >&4

    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
        "$iso" "$epoch" "$mem_total" "$mem_avail" "$mem_free" "$buffers" "$cached" \
        "$swap_total" "$swap_free" "$committed" "$cg_cur" "$cg_max" "$l1" "$procs_running" "$low" \
        "$shmem" "$slab" "$sreclaim" "$sunreclaim" "$pagetables" "$kstack" \
        "$anon" "$mapped" "$hugetlb" "$count" \
        "$( ((USE_PSS)) && echo pss || echo rss )" >&3

    if (( mem_avail < MIN_AVAIL )); then MIN_AVAIL=$mem_avail; MIN_AVAIL_AT=$iso; fi
    (( SAMPLES++ ))
    ROWS=$(( ROWS + count ))
    nap "$INTERVAL"
done
