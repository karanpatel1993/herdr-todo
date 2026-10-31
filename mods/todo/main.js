// To-do: a queue of instructions you write for the agent you're looking at.
//
// You add items as they occur to you while the agent works; nothing is sent
// until you say so. Send one, or send them all as a single numbered message.
// Sent items stay as a greyed record of what you asked for.
//
// One JSON file per terminal in ~/.config/herdr-app/todo/, so a list belongs to
// an agent and follows it across restarts. Sending uses `hc send <address>`,
// which carries the machine in the address — so this works for agents on other
// machines, unlike anything that writes files on their side.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { agents, focused, readTextFile, writeTextFile, appHome, theme, hc, watchFolder } from "herdr";
import * as fs from "fs/promises";

const dir = () => `${appHome()}/todo`;
const fileFor = (terminal) => `${dir()}/${terminal.replaceAll("/", "_")}.json`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export default class Todo extends View {
  init(_props, cx) {
    this.files = new Map();     // terminal -> { items, next }
    this.current = null;        // terminal address the panel is showing
    this.error = null;
    this.editing = null;        // item number being edited, or null

    this.input = InputState.new({ placeholder: "Add an instruction…" });
    this.input.on("submit", (_e, cx) => this.add(cx));

    this.edit = InputState.new({});
    this.edit.on("submit", (_e, cx) => this.commitEdit(cx));

    // Load what's on disk, then follow outside edits to the folder.
    cx.spawn(async (cx) => {
      await fs.mkdir(dir(), { recursive: true }).catch(() => {});
      await this.reload(cx);
      for (;;) {
        try { await watchFolder(dir()); } catch { return; }
        await this.reload(cx);
      }
    });
  }

  // ---- state -------------------------------------------------------------

  async reload(cx) {
    const names = (await fs.readdir(dir()).catch(() => [])).filter((n) => n.endsWith(".json") && !n.startsWith("."));
    const next = new Map();
    for (const name of names) {
      const raw = await readTextFile(`${dir()}/${name}`).catch(() => null);
      if (!raw) continue;
      try {
        const d = JSON.parse(raw);
        if (d?.terminal) next.set(d.terminal, { items: d.items ?? [], next: d.next ?? 1 });
      } catch { /* a half-written file: skip it, the watch will bring the next one */ }
    }
    this.files = next;
    cx.notify();
  }

  // Read-modify-write with the expected-contents guard, retried if it moved.
  async change(terminal, edit) {
    const path = fileFor(terminal);
    for (let tries = 0; tries < 3; tries++) {
      const raw = await readTextFile(path).catch(() => null);
      let data;
      try { data = raw ? JSON.parse(raw) : { terminal, items: [], next: 1 }; }
      catch { data = { terminal, items: [], next: 1 }; }
      data.terminal = terminal;
      edit(data);
      await fs.mkdir(dir(), { recursive: true }).catch(() => {});
      try {
        await writeTextFile(path, JSON.stringify(data, null, 1) + "\n", raw);
        this.files.set(terminal, { items: data.items, next: data.next });
        return;
      } catch { /* someone else wrote first; re-read and retry */ }
    }
    throw new Error("the file kept changing");
  }

  guard(cx, body) {
    cx.spawn(async (cx) => {
      try { this.error = null; await body(); }
      catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  // ---- actions -----------------------------------------------------------

  add(cx) {
    const terminal = this.current, text = this.input.value().trim();
    if (!terminal || !text) return;
    this.input.set_value("");
    this.guard(cx, () => this.change(terminal, (d) => {
      d.items.push({ n: d.next, text, sent: false });
      d.next += 1;
    }));
  }

  remove(n, cx) {
    const terminal = this.current;
    if (!terminal) return;
    if (this.editing === n) this.editing = null;
    this.guard(cx, () => this.change(terminal, (d) => { d.items = d.items.filter((i) => i.n !== n); }));
  }

  clearSent(cx) {
    const terminal = this.current;
    if (!terminal) return;
    this.guard(cx, () => this.change(terminal, (d) => { d.items = d.items.filter((i) => !i.sent); }));
  }

  startEdit(item, cx) {
    this.editing = item.n;
    this.edit.set_value(item.text);
    this.edit.focus();
    cx.notify();
  }

  commitEdit(cx) {
    const terminal = this.current, n = this.editing, text = this.edit.value().trim();
    this.editing = null;
    if (!terminal || n === null || !text) { cx.notify(); return; }
    this.guard(cx, () => this.change(terminal, (d) => {
      const item = d.items.find((i) => i.n === n);
      if (!item || item.text === text) return;   // opened and closed unchanged: leave it alone
      // `sent` means "this exact text was sent". Changing the text makes that
      // false, so the item goes back to pending rather than keeping a tick
      // that claims you sent something you didn't.
      item.text = text;
      item.sent = false;
    }));
  }

  // Send one item, or every pending one as a single numbered message. Only mark
  // them sent once hc reports success, so a failure leaves them queued.
  send(which, cx) {
    // One send at a time. Without this a second click lands before the first
    // marks anything sent, and the agent gets the instruction twice.
    if (this.sending) return;
    const terminal = this.current, file = this.files.get(terminal);
    if (!terminal || !file) return;
    // "all" takes only what's pending; a single item may be re-sent even once
    // it's been sent, so a missed instruction can be repeated without retyping.
    const batch = which === "all"
      ? file.items.filter((i) => !i.sent)
      : file.items.filter((i) => i.n === which);
    if (batch.length === 0) return;

    const text = batch.length === 1
      ? batch[0].text
      : batch.map((i, k) => `${k + 1}. ${i.text}`).join("\n");

    this.sending = which;
    this.guard(cx, async () => {
      try {
        const r = await hc(["send", terminal, text]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc send failed").trim());
        const ns = new Set(batch.map((i) => i.n));
        await this.change(terminal, (d) => {
          for (const i of d.items) if (ns.has(i.n)) i.sent = true;
        });
      } finally { this.sending = null; }
    });
  }

  // ---- render ------------------------------------------------------------

  render(cx) {
    const t = theme();
    const f = focused();
    // `terminal` is the focused terminal; `agent` only means something when a
    // layout agent block has focus, and it keeps the LAST agent otherwise — so
    // reading it first pins the panel to a stale agent whenever a plain shell
    // is focused, and items get filed against the wrong one.
    const terminal = f?.terminal ?? f?.agent ?? null;
    if (terminal !== this.current) { this.current = terminal; this.editing = null; }

    const file = terminal ? this.files.get(terminal) : null;
    const items = file?.items ?? [];
    const pending = items.filter((i) => !i.sent);
    const agent = agents().find((a) => a.address === terminal);
    const title = agent ? `${agent.space_name} · ${agent.tab_name}` : terminal ?? "";

    const btn = (id, label, kind, action) => {
      const solid = kind === "solid";
      return h_flex().id(id).h(24).px(9).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(11.5).font_medium()
        .bg(solid ? t.solid : t.raised).text_color(solid ? t.solid_foreground : t.foreground)
        .hover((s) => s.opacity(0.85)).on_click(action).child(label);
    };

    const row = (i) => {
      if (this.editing === i.n) {
        return h_flex().id(`e-${i.n}`).w_full().py(4).gap(6).items_center()
          .child(Input.new(this.edit).flex_1().h(28).px(8).rounded(7).border_1()
            .border_color(t.accent).bg(t.background).text_size(12).text_color(t.foreground))
          .child(btn(`ed-${i.n}`, "Save", "solid", (_e, cx) => this.commitEdit(cx)));
      }
      return h_flex().id(`i-${i.n}`).w_full().py(5).gap(8).items_start()
        .child(div().flex_1().min_w(0).text_size(12.5)
          .text_color(i.sent ? t.dim : t.foreground)
          .when(i.sent, (el) => el.line_through())
          .cursor_pointer().on_click((_e, cx) => this.startEdit(i, cx))
          .child(i.text))
        .child(
          h_flex().id(`s-${i.n}`).h(24).px(9).flex_none().items_center().rounded(6)
            .text_size(11.5).font_medium()
            .bg(i.sent ? t.background : t.raised).text_color(i.sent ? t.dim : t.foreground)
            .when(Boolean(this.sending), (b) => b.opacity(0.45))
            .when(!this.sending, (b) => b.cursor_pointer().hover((s) => s.opacity(0.85))
              .on_click((_e, cx) => this.send(i.n, cx)))
            .child(this.sending === i.n ? "Sending…" : i.sent ? "Resend" : "Send"))
        .child(div().id(`x-${i.n}`).px(5).text_size(13).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.remove(i.n, cx)).child("×"));
    };

    const header = h_flex().w_full().flex_none().px(14).h(44).items_center().gap(8)
      .border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).text_size(13).font_semibold().truncate().child("To-do"))
      .when(pending.length > 0, (el) => el.child(div().px(7).py(2).rounded(6).bg(t.raised)
        .text_size(11).text_color(t.dim).child(`${pending.length} pending`)));

    if (!terminal) {
      return v_flex().size_full().bg(t.background).child(header)
        .child(div().p(14).text_size(12).text_color(t.dim)
          .child("Focus an agent or terminal to keep a list for it."));
    }

    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(header)
      .child(div().px(14).pt(10).text_size(11).text_color(t.dim).truncate().child(clip(title, 60)))
      .child(div().px(14).pt(8).flex_none()
        .child(Input.new(this.input).w_full().h(30).px(9).rounded(8).border_1()
          .border_color(t.input).bg(t.background).text_size(12.3).text_color(t.foreground)))
      .when(Boolean(this.error), (el) => el.child(div().px(14).pt(8).text_size(11.5)
        .text_color(t.danger ?? t.foreground).child(this.error)))
      .child(v_flex().id("todo-list").flex_1().min_h(0).px(14).pt(6).overflow_y_scrollbar()
        .when(items.length === 0, (el) => el.child(div().pt(6).text_size(12).text_color(t.dim)
          .child("Nothing yet. Type above and press Enter.")))
        .children(items.map(row))
        .child(Scrollbar.vertical()))
      .child(h_flex().w_full().flex_none().px(14).py(10).gap(8).items_center()
        .border_t(1).border_color(t.border)
        .child(div().flex_1())
        .when(items.some((i) => i.sent), (el) =>
          el.child(btn("clear-sent", "Clear sent", "soft", (_e, cx) => this.clearSent(cx))))
        .when(pending.length > 0, (el) => el.child(
          h_flex().id("send-all").h(24).px(9).flex_none().items_center().rounded(6)
            .text_size(11.5).font_medium().bg(t.solid).text_color(t.solid_foreground)
            .when(Boolean(this.sending), (b) => b.opacity(0.45))
            .when(!this.sending, (b) => b.cursor_pointer().hover((s) => s.opacity(0.85))
              .on_click((_e, cx) => this.send("all", cx)))
            .child(this.sending === "all" ? "Sending…" : `Send all (${pending.length})`))));
  }
}
