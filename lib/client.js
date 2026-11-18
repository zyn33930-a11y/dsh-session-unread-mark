window.__ModuleLoader__.load({
	id: "@zyn333/dsh-session-unread-mark",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { jsx } = require("react/jsx-runtime");
		const { MenuItemButton } = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Locale namespace owned by this plugin. */
		const NS = "sessionUnreadMark";
		/** Document-relative Host routes (see lib/host.js); the login cookie authenticates them. */
		const STATE_ROUTE = "api/session-unread-mark.state";
		const SET_ROUTE = "api/session-unread-mark.set";
		/** localStorage key of the earlier browser-only version; migrated once, then removed. */
		const LEGACY_STORAGE_KEY = "dsh.sessionUnreadMark.v1";
		/** Re-read the Host marks this often while the page is visible, so other devices' changes appear. */
		const REFRESH_MS = 30000;

		const zh = { markUnread: "标为未读", markRead: "标为已读" };
		const en = { markUnread: "Mark as unread", markRead: "Mark as read" };

		/**
		 * Parse `{ ids: { sessionId: { armed, manual } } }` into a Map.
		 * `manual: true` is a user "mark as unread": it stays while the session is
		 * open and while the user is elsewhere, and clears the next time this
		 * device opens the session. `manual: false` is a persisted automatic
		 * "finished while away" dot, which also clears whenever the session is in view.
		 * `armed` is only written for older clients.
		 */
		function parseIds(value) {
			const marks = new Map();
			const ids = value && typeof value === "object" ? value.ids : undefined;
			if (ids && typeof ids === "object") {
				for (const [id, mark] of Object.entries(ids)) marks.set(id, { armed: true, manual: mark?.manual === true });
			}
			return marks;
		}

		function readLegacyMarks() {
			try {
				const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
				return raw === null ? undefined : parseIds(JSON.parse(raw));
			} catch {
				return undefined;
			}
		}

		function clearLegacyMarks() {
			try {
				window.localStorage.removeItem(LEGACY_STORAGE_KEY);
			} catch {}
		}

		/** Sequential Host calls: a read queued after a write always observes it. */
		var RemoteMarks = class {
			constructor() {
				this.queue = Promise.resolve();
				this.inflight = 0;
				this.lifetime = new AbortController();
			}
			enqueue(task) {
				this.inflight++;
				const next = this.queue.then(task).finally(() => {
					this.inflight--;
				});
				this.queue = next.catch(() => {});
				return next;
			}
			async call(route, init) {
				const response = await fetch(route, { cache: "no-store", ...init, signal: this.lifetime.signal });
				if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
				return parseIds(await response.json());
			}
			read() {
				return this.enqueue(() => this.call(STATE_ROUTE));
			}
			write(changes) {
				return this.enqueue(() => this.call(SET_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ changes })
				}));
			}
			dispose() {
				this.lifetime.abort();
			}
		};

		/** Keeps ui-session's in-memory unread set and the Host-persisted marks in agreement. */
		var UnreadController = class {
			constructor(ui, sessions, remote) {
				this.ui = ui;
				this.sessions = sessions;
				this.remote = remote;
				this.marks = new Map();
				this.ready = false;
				this.loading = false;
				this.disposed = false;
				this.listeners = new Set();
				this.version = 0;
				this.syncing = false;
				this.subscribe = (listener) => {
					this.listeners.add(listener);
					return () => this.listeners.delete(listener);
				};
				this.getVersion = () => this.version;
			}
			emit() {
				this.version++;
				for (const listener of [...this.listeners]) listener();
			}
			isMain(id) {
				return (this.sessions.list.getSnapshot().byId[id]?.retainedBy?.mainView ?? 0) > 0;
			}
			isRunning(id) {
				const status = this.ui.sessionStatus.getSnapshot().get(id);
				return (status?.running ?? this.sessions.list.getSnapshot().byId[id]?.running) === true;
			}
			isUnread(id) {
				return this.marks.has(id) || this.ui.sessionStatus.getSnapshot().get(id)?.completionUnread === true;
			}
			/** Send local changes; the Host answer is adopted once no other call is pending. */
			push(changes) {
				if (changes.length === 0 || this.disposed) return;
				this.remote.write(changes).then((marks) => this.adopt(marks, true), (error) => {
					if (this.disposed) return;
					console.error("[session-unread-mark] cannot save unread marks on the Host", error);
					this.load();
				});
			}
			/**
			 * Replace local marks with the Host's. `prune` also clears in-memory
			 * unread dots another device has read; the first load keeps them so
			 * the next sync can persist them.
			 */
			adopt(marks, prune) {
				if (this.disposed || this.remote.inflight > 0) return;
				this.marks = marks;
				if (prune) {
					let publish = false;
					for (const id of [...this.ui.completionUnread]) {
						if (!marks.has(id)) {
							this.ui.completionUnread.delete(id);
							publish = true;
						}
					}
					if (publish) this.ui.publishStatus();
				}
				this.sync();
			}
			/** First call migrates and loads; later calls refresh from the Host. */
			load() {
				if (this.disposed || this.loading) return;
				this.loading = true;
				const first = !this.ready;
				this.remote.read().then(async (marks) => {
					if (first) {
						const legacy = readLegacyMarks();
						if (legacy !== undefined) {
							const changes = [];
							for (const [id, mark] of legacy) if (!marks.has(id)) changes.push({ id, mark });
							if (changes.length > 0) marks = await this.remote.write(changes);
							clearLegacyMarks();
						}
						this.ready = true;
					}
					this.loading = false;
					this.adopt(marks, !first);
				}).catch((error) => {
					this.loading = false;
					if (!this.disposed) console.error("[session-unread-mark] cannot read unread marks from the Host", error);
				});
			}
			/** Reconcile after any list or status change; changes go to the Host. */
			sync() {
				if (!this.ready) return;
				if (this.syncing) {
					// A change arrived while reconciling: run once more afterwards so no main-view transition is missed.
					this.syncAgain = true;
					return;
				}
				this.syncing = true;
				const changes = [];
				let publish = false;
				try {
					const list = this.sessions.list.getSnapshot();
					const statuses = this.ui.sessionStatus.getSnapshot();
					// Sessions shown in this device's main view now, and at the previous reconcile.
					const mainNow = new Set();
					for (const [id, row] of Object.entries(list.byId)) if ((row?.retainedBy?.mainView ?? 0) > 0) mainNow.add(id);
					// The first reconcile after page load (or right after leaving every session) is not an "open":
					// refreshing the page while a marked session is shown keeps its mark.
					const mainBefore = this.mainIds;
					const opened = (id) => mainNow.has(id) && mainBefore !== undefined && mainBefore.size > 0 && !mainBefore.has(id);
					// Persist automatic "finished while you were away" marks too, so they survive refresh and reach other devices.
					for (const [id, status] of statuses) {
						if (status.completionUnread === true && !this.marks.has(id)) {
							const mark = { armed: true, manual: false };
							this.marks.set(id, mark);
							changes.push({ id, mark });
						}
					}
					for (const [id, mark] of [...this.marks]) {
						if (list.byId[id] === undefined) {
							// Deleted session: drop only once the list baseline is authoritative.
							if (list.phase === "ready") {
								this.marks.delete(id);
								changes.push({ id, mark: null });
							}
							continue;
						}
						// Opening the session on this device reads both kinds of mark.
						// An automatic mark is also read whenever its session is in view, as DSH itself does.
						if (opened(id) || (!mark.manual && mainNow.has(id))) {
							this.marks.delete(id);
							changes.push({ id, mark: null });
							if (this.ui.completionUnread.delete(id)) publish = true;
							continue;
						}
						if (this.isRunning(id)) {
							// The running dot takes precedence. An automatic mark is superseded by the new run
							// (its own completion re-marks it); a manual mark waits for the run to finish.
							if (!mark.manual) {
								this.marks.delete(id);
								changes.push({ id, mark: null });
							}
							continue;
						}
						// Show the dot, including on the session currently open (DSH drops it from its own set on
						// every list change; re-adding it here keeps a manual mark visible while you stay on it).
						if (!this.ui.completionUnread.has(id)) {
							this.ui.completionUnread.add(id);
							publish = true;
						}
					}
					this.mainIds = mainNow;
					if (publish) this.ui.publishStatus();
				} finally {
					this.syncing = false;
				}
				this.push(changes);
				this.emit();
				if (this.syncAgain) {
					this.syncAgain = false;
					this.sync();
				}
			}
			markUnread(id) {
				const mark = { armed: true, manual: true };
				this.marks.set(id, mark);
				this.push([{ id, mark }]);
				this.sync();
			}
			markRead(id) {
				this.marks.delete(id);
				this.push([{ id, mark: null }]);
				if (this.ui.completionUnread.delete(id)) this.ui.publishStatus();
				this.sync();
			}
			dispose() {
				this.disposed = true;
				this.remote.dispose();
			}
		};

		function UnreadIcon({ filled }) {
			return jsx("svg", {
				width: 16,
				height: 16,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": true,
				children: jsx("circle", {
					cx: 8,
					cy: 8,
					r: filled ? 4 : 3.5,
					fill: filled ? "currentColor" : "none",
					stroke: "currentColor",
					strokeWidth: 1.5
				})
			});
		}

		/** Row "..." menu entry toggling the unread mark. */
		function UnreadMenuItem({ sessionId, useMenuOpenState, controller, t }) {
			const [, setMenuOpen] = useMenuOpenState();
			React.useSyncExternalStore(controller.subscribe, controller.getVersion);
			if (!controller.ready) return null;
			const unread = controller.isUnread(sessionId);
			return jsx(MenuItemButton, {
				icon: jsx(UnreadIcon, { filled: !unread }),
				onSelect: () => {
					setMenuOpen(false);
					if (unread) controller.markRead(sessionId);
					else controller.markUnread(sessionId);
				},
				children: t(unread ? "markRead" : "markUnread")
			});
		}

		const inject = ["slots", "locale", "sessions", "uiSession"];

		function apply(ctx) {
			const ui = ctx.uiSession;
			if (!(ui?.completionUnread instanceof Set) || typeof ui.publishStatus !== "function" || typeof ui.sessionStatus?.subscribe !== "function") {
				console.warn("[session-unread-mark] ui-session internals changed; plugin disabled for this DSH version");
				return;
			}
			const controller = new UnreadController(ui, ctx.sessions, new RemoteMarks());
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-unread-mark: dictionaries");
			ctx.effect(() => {
				const sync = () => controller.sync();
				const disposeList = ctx.sessions.list.subscribe(sync);
				const disposeStatus = ui.sessionStatus.subscribe(sync);
				const refresh = () => {
					if (document.visibilityState === "visible") controller.load();
				};
				document.addEventListener("visibilitychange", refresh);
				window.addEventListener("focus", refresh);
				const timer = setInterval(refresh, REFRESH_MS);
				controller.load();
				return () => {
					clearInterval(timer);
					document.removeEventListener("visibilitychange", refresh);
					window.removeEventListener("focus", refresh);
					disposeList();
					disposeStatus();
					controller.dispose();
				};
			}, "session-unread-mark: Host sync");
			// Order 150: right after the shipped Pin (100), before Rename (200).
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "session-unread-mark.toggle",
				order: 150,
				locale: NS,
				inject: () => ({ controller })
			}, UnreadMenuItem));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
