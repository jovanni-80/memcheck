"""
cursesdb.py - a small curses front-end for pdb (standard library only).

Usage, either:
    PYTHONBREAKPOINT=cursesdb.set_trace python your_script.py
or inside your script:
    import sys, cursesdb
    sys.breakpointhook = cursesdb.set_trace

Keys
    n / s / r / c   next, step, return, continue
    q               quit (raises BdbQuit, like pdb)
    u / d           move up / down the call stack
    b               toggle breakpoint on the cursor line
    t               run to the cursor line
    :               type any pdb command or Python expression (p x, x = 5, where, ...)
    Tab             switch pane (source, locals, stack, output)
    Up/Down/PgUp/PgDn   move within the focused pane
    Enter           locals: show full value / stack: jump to that frame
    o               view the program's own terminal output
"""
import curses
import builtins
import keyword
import linecache
import os
import pdb
import pprint
import re
import reprlib
import sys

HELP = (" n:next s:step r:return c:cont q:quit u/d:frame "
        "b:break t:run-to  ::cmd  o:output  Tab:pane ")

TOKEN_RE = re.compile(
    r"(?P<comment>#.*$)"
    r"|(?P<string>\"(?:[^\"\\]|\\.)*\"?|'(?:[^'\\]|\\.)*'?)"
    r"|(?P<number>\b\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?j?\b)"
    r"|(?P<name>\b[A-Za-z_]\w*\b)"
)
BUILTIN_NAMES = set(dir(builtins))
PANES = ["source", "locals", "stack", "output"]
MAX_OUTPUT_LINES = 2000

# colour pair ids
C_KEYWORD, C_STRING, C_COMMENT, C_NUMBER, C_BUILTIN, C_CURRENT, C_BAR, C_BREAK = range(1, 9)


class _PaneWriter:
    """File-like object that collects pdb's output into a list of lines."""

    def __init__(self, sink):
        self.sink = sink
        self.partial = ""

    def write(self, s):
        parts = (self.partial + s).split("\n")
        self.sink.extend(parts[:-1])
        self.partial = parts[-1]
        del self.sink[:-MAX_OUTPUT_LINES]
        return len(s)

    def flush(self):
        if self.partial:
            self.sink.append(self.partial)
            self.partial = ""


class CursesPdb(pdb.Pdb):
    def __init__(self, *args, **kwargs):
        self.output_lines = []
        kwargs.setdefault("stdout", _PaneWriter(self.output_lines))
        super().__init__(*args, **kwargs)
        self.history = []
        self.focus = 0
        self.cursor = {"source": None, "locals": 0, "stack": 0}
        self.tops = {}
        self.pane_h = {}
        self.out_top = None          # None = follow the newest output
        self.loc_items = []

    # ------------------------------------------------------------ pdb hooks
    def interaction(self, frame, tb_or_exc):
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            # No real terminal (IDE console, piped I/O): fall back to plain pdb.
            self.stdout = sys.stdout
            return super().interaction(frame, tb_or_exc)

        tb = tb_or_exc.__traceback__ if isinstance(tb_or_exc, BaseException) else tb_or_exc
        self.setup(frame, tb)
        self._reset_cursors()
        try:
            curses.wrapper(self._ui)
        finally:
            self.stdout.flush()
            self.forget()

    # ------------------------------------------------------------ helpers
    def _locals(self):
        return getattr(self, "curframe_locals", None) or self.curframe.f_locals

    def _location(self):
        frame, lineno = self.stack[self.curindex]
        return frame, self.canonic(frame.f_code.co_filename), lineno

    def _reset_cursors(self):
        _, _, lineno = self._location()
        self.cursor["source"] = lineno
        self.cursor["stack"] = self.curindex
        self.cursor["locals"] = 0
        self.tops.pop("source", None)

    def run_cmd(self, line, echo=True, quiet=False):
        """Run a pdb command; return True if execution should resume."""
        if echo:
            self.output_lines.append(f"(cdb) {line}")
        mark = len(self.output_lines)
        try:
            stop = self.onecmd(line)
        except Exception as e:  # never let a bad command kill the UI
            self.output_lines.append(f"*** {type(e).__name__}: {e}")
            stop = False
        self.stdout.flush()
        if quiet:
            del self.output_lines[mark:]
        self.out_top = None
        return bool(stop)

    # ------------------------------------------------------------ main loop
    def _ui(self, stdscr):
        self.stdscr = stdscr
        try:
            curses.set_escdelay(25)
        except AttributeError:
            pass
        try:
            curses.curs_set(0)
        except curses.error:
            pass
        self._init_colors()
        stdscr.keypad(True)

        while True:
            self._draw()
            key = stdscr.get_wch()
            pane = PANES[self.focus]

            if key == curses.KEY_RESIZE:
                continue
            elif key == "\t":
                self.focus = (self.focus + 1) % len(PANES)
            elif key == curses.KEY_BTAB:
                self.focus = (self.focus - 1) % len(PANES)
            elif key in (curses.KEY_UP, "k"):
                self._move(pane, -1)
            elif key in (curses.KEY_DOWN, "j"):
                self._move(pane, 1)
            elif key == curses.KEY_PPAGE:
                self._move(pane, -max(1, self.pane_h.get(pane, 10) - 1))
            elif key == curses.KEY_NPAGE:
                self._move(pane, max(1, self.pane_h.get(pane, 10) - 1))
            elif key in ("\n", "\r", curses.KEY_ENTER):
                self._activate(pane)
            elif key in ("n", "s", "r", "c"):
                cmd = {"n": "next", "s": "step", "r": "return", "c": "continue"}[key]
                if self.run_cmd(cmd, echo=False):
                    return
            elif key == "q":
                self.set_quit()
                return
            elif key in ("u", "d"):
                self.run_cmd("up" if key == "u" else "down", echo=False, quiet=True)
                self._reset_cursors()
            elif key == "b":
                self._toggle_break()
            elif key == "t":
                _, filename, _ = self._location()
                line = self.cursor["source"]
                if self.checkline(filename, line):
                    self.set_break(filename, line, temporary=True)
                    if self.run_cmd("continue", echo=False):
                        return
            elif key == ":":
                line = self._prompt()
                if line:
                    self.history.append(line)
                    if self.run_cmd(line):
                        return
                    self._reset_cursors()  # the command may have moved frames
            elif key == "o":
                self._show_program_output()

    def _move(self, pane, delta):
        if pane == "source":
            _, filename, _ = self._location()
            total = max(1, len(linecache.getlines(filename)))
            self.cursor["source"] = min(max(1, self.cursor["source"] + delta), total)
        elif pane == "locals":
            last = max(0, len(self.loc_items) - 1)
            self.cursor["locals"] = min(max(0, self.cursor["locals"] + delta), last)
        elif pane == "stack":
            last = len(self.stack) - 1
            self.cursor["stack"] = min(max(0, self.cursor["stack"] + delta), last)
        elif pane == "output":
            h = self.pane_h.get("output", 3)
            bottom = max(0, len(self.output_lines) - h)
            top = bottom if self.out_top is None else self.out_top
            top = min(max(0, top + delta), bottom)
            self.out_top = None if top >= bottom else top

    def _activate(self, pane):
        if pane == "locals" and self.loc_items:
            name, value = self.loc_items[self.cursor["locals"]]
            try:
                text = pprint.pformat(value, width=100)
            except Exception as e:
                text = f"<unprintable: {e!r}>"
            self.output_lines.append(f"{name} =")
            self.output_lines.extend("    " + l for l in text.splitlines())
            self.out_top = None
        elif pane == "stack":
            diff = self.cursor["stack"] - self.curindex
            if diff:
                cmd = f"down {diff}" if diff > 0 else f"up {-diff}"
                self.run_cmd(cmd, echo=False, quiet=True)
                self._reset_cursors()

    def _toggle_break(self):
        _, filename, _ = self._location()
        line = self.cursor["source"]
        if self.get_breaks(filename, line):
            self.clear_break(filename, line)
            self.output_lines.append(f"Cleared breakpoint at {os.path.basename(filename)}:{line}")
        elif self.checkline(filename, line):
            err = self.set_break(filename, line)
            msg = err or f"Breakpoint set at {os.path.basename(filename)}:{line}"
            self.output_lines.append(msg)
        self.stdout.flush()
        self.out_top = None

    def _prompt(self):
        """Single-line input on the bottom row. Esc cancels, Up/Down = history."""
        scr = self.stdscr
        h, w = scr.getmaxyx()
        buf, hist_i = "", len(self.history)
        try:
            curses.curs_set(1)
        except curses.error:
            pass
        while True:
            scr.move(h - 1, 0)
            scr.clrtoeol()
            text = ":" + buf
            self._put(scr, h - 1, 0, text[-(w - 1):], 0, w - 1)
            scr.move(h - 1, min(len(text), w - 2))
            ch = scr.get_wch()
            if ch in ("\n", "\r", curses.KEY_ENTER):
                break
            if ch == "\x1b":
                buf = ""
                break
            if ch in (curses.KEY_BACKSPACE, "\x7f", "\b"):
                buf = buf[:-1]
            elif ch == curses.KEY_UP and self.history:
                hist_i = max(0, hist_i - 1)
                buf = self.history[hist_i]
            elif ch == curses.KEY_DOWN and self.history:
                hist_i = min(len(self.history), hist_i + 1)
                buf = self.history[hist_i] if hist_i < len(self.history) else ""
            elif isinstance(ch, str) and ch.isprintable():
                buf += ch
        try:
            curses.curs_set(0)
        except curses.error:
            pass
        return buf.strip()

    def _show_program_output(self):
        curses.def_prog_mode()
        curses.endwin()
        out = sys.__stdout__
        out.write("\n-- program output above; press Enter to return to the debugger --")
        out.flush()
        sys.__stdin__.readline()
        curses.reset_prog_mode()
        self.stdscr.clear()

    # ------------------------------------------------------------ drawing
    def _init_colors(self):
        self.attr = {}
        if not curses.has_colors():
            for k in range(1, 9):
                self.attr[k] = curses.A_REVERSE if k in (C_CURRENT, C_BAR) else 0
            return
        curses.start_color()
        try:
            curses.use_default_colors()
            bg = -1
        except curses.error:
            bg = curses.COLOR_BLACK
        pairs = {
            C_KEYWORD: (curses.COLOR_MAGENTA, bg),
            C_STRING: (curses.COLOR_GREEN, bg),
            C_COMMENT: (curses.COLOR_BLUE, bg),
            C_NUMBER: (curses.COLOR_YELLOW, bg),
            C_BUILTIN: (curses.COLOR_CYAN, bg),
            C_CURRENT: (curses.COLOR_BLACK, curses.COLOR_GREEN),
            C_BAR: (curses.COLOR_BLACK, curses.COLOR_CYAN),
            C_BREAK: (curses.COLOR_RED, bg),
        }
        for pid, (fg, b) in pairs.items():
            curses.init_pair(pid, fg, b)
            self.attr[pid] = curses.color_pair(pid)
        self.attr[C_KEYWORD] |= curses.A_BOLD
        self.attr[C_BREAK] |= curses.A_BOLD

    @staticmethod
    def _put(win, y, x, text, attr=0, limit=None):
        """addnstr that clips to `limit` columns and ignores edge errors."""
        if limit is None:
            limit = win.getmaxyx()[1] - 1 - x
        if limit <= 0:
            return 0
        try:
            win.addnstr(y, x, text, limit, attr)
        except curses.error:
            pass
        return min(len(text), limit)

    def _box(self, y, x, h, w, title, name):
        focused = PANES[self.focus] == name
        win = self.stdscr.derwin(h, w, y, x)
        attr = curses.A_BOLD if focused else 0
        win.attron(attr)
        win.box()
        win.attroff(attr)
        self._put(win, 0, 2, f" {title} ", attr | (curses.A_REVERSE if focused else 0))
        self.pane_h[name] = h - 2
        return win, focused

    def _visible_top(self, name, cursor, height, total):
        top = self.tops.get(name, max(0, cursor - height // 2))
        if cursor < top:
            top = cursor
        elif cursor >= top + height:
            top = cursor - height + 1
        top = max(0, min(top, max(0, total - height)))
        self.tops[name] = top
        return top

    def _draw(self):
        scr = self.stdscr
        scr.erase()
        h, w = scr.getmaxyx()
        if h < 12 or w < 50:
            self._put(scr, 0, 0, "Terminal too small for cursesdb", 0, w - 1)
            scr.refresh()
            return

        frame, filename, lineno = self._location()
        title = f" cursesdb  {os.path.basename(filename)}:{lineno}  in {frame.f_code.co_name}()"
        exc = self._locals().get("__exception__")
        if exc:
            title += f"   !! {exc[0].__name__}: {exc[1]}"
        self._put(scr, 0, 0, title.ljust(w), self.attr[C_BAR], w)
        self._put(scr, h - 1, 0, HELP.ljust(w), self.attr[C_BAR], w - 1)

        out_h = max(4, h // 4)
        body_h = h - 2 - out_h
        src_w = w * 3 // 5
        side_w = w - src_w
        loc_h = body_h * 3 // 5

        self._draw_source(*self._box(1, 0, body_h, src_w, "Source", "source"), filename, lineno)
        self._draw_locals(*self._box(1, src_w, loc_h, side_w, "Locals", "locals"))
        self._draw_stack(*self._box(1 + loc_h, src_w, body_h - loc_h, side_w, "Stack", "stack"))
        self._draw_output(*self._box(1 + body_h, 0, out_h, w, "Output", "output"))
        scr.refresh()

    def _draw_source(self, win, focused, filename, lineno):
        wh, ww = win.getmaxyx()
        height, width = wh - 2, ww - 2
        lines = linecache.getlines(filename, self.curframe.f_globals)
        if not lines:
            self._put(win, 1, 1, "<source not available>")
            return
        cursor = self.cursor["source"]
        numw = len(str(len(lines)))
        top = self._visible_top("source", cursor - 1, height, len(lines))

        for row in range(height):
            n = top + row + 1
            if n > len(lines):
                break
            y = row + 1
            text = lines[n - 1].rstrip("\n").expandtabs(4)
            has_bp = bool(self.get_breaks(filename, n))
            self._put(win, y, 1, "B" if has_bp else " ", self.attr[C_BREAK])
            self._put(win, y, 2, f"{'>' if n == lineno else ' '}{n:>{numw}} ",
                      curses.A_BOLD if n == lineno else curses.A_DIM)
            x0 = numw + 4
            avail = width - x0 + 1
            if n == lineno:
                self._put(win, y, x0, text.ljust(avail), self.attr[C_CURRENT], avail)
            elif n == cursor and focused:
                self._put(win, y, x0, text.ljust(avail), curses.A_REVERSE, avail)
            else:
                self._draw_code(win, y, x0, text, avail)
            if n == cursor and focused and n == lineno:
                self._put(win, y, 2, ">", curses.A_REVERSE | curses.A_BOLD)

    def _draw_code(self, win, y, x, text, avail):
        col, pos = 0, 0

        def emit(segment, attr=0):
            nonlocal col
            if col < avail and segment:
                col += self._put(win, y, x + col, segment, attr, avail - col)

        for m in TOKEN_RE.finditer(text):
            emit(text[pos:m.start()])
            tok, kind = m.group(), m.lastgroup
            if kind == "comment":
                attr = self.attr[C_COMMENT]
            elif kind == "string":
                attr = self.attr[C_STRING]
            elif kind == "number":
                attr = self.attr[C_NUMBER]
            elif keyword.iskeyword(tok) or tok in ("self", "cls"):
                attr = self.attr[C_KEYWORD]
            elif tok in BUILTIN_NAMES:
                attr = self.attr[C_BUILTIN]
            else:
                attr = 0
            emit(tok, attr)
            pos = m.end()
        emit(text[pos:])

    def _draw_locals(self, win, focused):
        wh, ww = win.getmaxyx()
        height, width = wh - 2, ww - 2
        self.loc_items = sorted(
            ((k, v) for k, v in self._locals().items()
             if not (k.startswith("__") and k.endswith("__"))),
            key=lambda kv: kv[0])
        if not self.loc_items:
            self._put(win, 1, 1, "(no locals)", curses.A_DIM)
            return
        self.cursor["locals"] = min(self.cursor["locals"], len(self.loc_items) - 1)
        cursor = self.cursor["locals"]
        top = self._visible_top("locals", cursor, height, len(self.loc_items))
        name_w = min(16, max(len(k) for k, _ in self.loc_items))
        for row, (name, value) in enumerate(self.loc_items[top:top + height]):
            try:
                r = reprlib.repr(value)
            except Exception as e:
                r = f"<repr failed: {type(e).__name__}>"
            line = f"{name[:name_w]:<{name_w}} {type(value).__name__[:10]:<10} {r}"
            sel = focused and top + row == cursor
            self._put(win, row + 1, 1, line.ljust(width),
                      curses.A_REVERSE if sel else 0, width)

    def _draw_stack(self, win, focused):
        wh, ww = win.getmaxyx()
        height, width = wh - 2, ww - 2
        cursor = self.cursor["stack"]
        top = self._visible_top("stack", cursor, height, len(self.stack))
        for row, (frame, lineno) in enumerate(self.stack[top:top + height]):
            i = top + row
            fname = os.path.basename(frame.f_code.co_filename)
            line = f"{'>' if i == self.curindex else ' '} {frame.f_code.co_name}  {fname}:{lineno}"
            attr = curses.A_BOLD if i == self.curindex else 0
            if focused and i == cursor:
                attr |= curses.A_REVERSE
            self._put(win, row + 1, 1, line.ljust(width), attr, width)

    def _draw_output(self, win, focused):
        wh, ww = win.getmaxyx()
        height, width = wh - 2, ww - 2
        lines = self.output_lines
        top = max(0, len(lines) - height) if self.out_top is None else self.out_top
        for row, text in enumerate(lines[top:top + height]):
            attr = self.attr[C_BREAK] if text.startswith("***") else 0
            self._put(win, row + 1, 1, text.expandtabs(4), attr, width)


_instance = None


def set_trace():
    """Entry point for PYTHONBREAKPOINT / sys.breakpointhook."""
    global _instance
    if _instance is None:
        _instance = CursesPdb()
    _instance.set_trace(sys._getframe(1))


def post_mortem(tb=None):
    """Debug a traceback (defaults to the exception currently being handled)."""
    tb = tb or sys.exc_info()[2]
    if tb is None:
        raise ValueError("no traceback to debug")
    p = CursesPdb()
    p.reset()
    p.interaction(None, tb)
