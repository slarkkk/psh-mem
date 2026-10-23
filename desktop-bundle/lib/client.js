window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/state.ts
		/**
		* Memory editor state: the same-origin memory API transport plus the published
		* editing snapshot. One controller is created per plugin lifecycle in apply()
		* and shared by every session's tab through the registration's inject face.
		*
		* The API is served by the host plugin on the page's own origin, so every
		* request uses a relative URL and the required `x-dsh-memory` header. A
		* non-2xx response, or a refusal body the API returns with 2xx, is a failure
		* whose user-visible text the `memory` dictionary owns.
		*/
		/** Request header the memory API requires; it answers 403 without it. */
		const MEMORY_HEADER = "x-dsh-memory";
		/** Value sent for {@link MEMORY_HEADER}. */
		const MEMORY_HEADER_VALUE = "1";
		/** State route; relative so the request stays same-origin. */
		const STATE_ROUTE = "/memory/state";
		/** Write route; relative so the request stays same-origin. */
		const WRITE_ROUTE = "/memory/write";
		/** The two editable targets, in display order. */
		const MEMORY_TARGETS = ["user", "memory"];
		/** A memory API response outside the 2xx range. */
		var MemoryHttpError = class extends Error {
			/** HTTP status the API answered with. */
			status;
			/**
			* @param status - HTTP status the API answered with.
			*/
			constructor(status) {
				super(`memory API answered HTTP ${status}`);
				this.status = status;
			}
		};
		/** One section with nothing loaded and nothing staged. */
		function emptySection() {
			return {
				entries: [],
				drafts: {},
				removed: [],
				additions: [],
				chars: 0,
				limit: 0
			};
		}
		/**
		* The operations one section's staged edits translate to: removals and
		* replacements in loaded entry order, then additions in staging order. An
		* entry marked for removal yields only `remove`; a draft equal to the loaded
		* text yields nothing.
		* @param section - staged section state.
		* @returns the operations to post for this target (empty when nothing changed).
		*/
		function pendingOperations(section) {
			const operations = [];
			section.entries.forEach((text, index) => {
				if (section.removed.includes(index)) {
					operations.push({
						action: "remove",
						oldText: text
					});
					return;
				}
				const draft = section.drafts[index];
				if (draft !== void 0 && draft !== text) operations.push({
					action: "replace",
					oldText: text,
					content: draft
				});
			});
			for (const content of section.additions) operations.push({
				action: "add",
				content
			});
			return operations;
		}
		/**
		* Create the shared memory editor store. Declared once at register and handed
		* to every session's tab through the registration's inject face.
		* @returns the published editor snapshot store.
		*/
		function createMemoryStore() {
			return (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				phase: "loading",
				sections: {
					user: emptySection(),
					memory: emptySection()
				},
				saving: null,
				notice: null
			});
		}
		/**
		* Replace the named sections with a report's authoritative entries and usage,
		* dropping their staged drafts, removals, and additions. Sections the report
		* does not cover, and sections not named here, keep their staged edits.
		* @param draft - editor snapshot draft.
		* @param report - state report, or the snapshot of a write.
		* @param targets - sections to adopt.
		*/
		function adoptReport(draft, report, targets) {
			for (const target of targets) {
				const reported = report.targets.find((candidate) => candidate.target === target);
				if (reported === void 0) continue;
				const section = draft.sections[target];
				section.entries = [...reported.entries];
				section.chars = reported.chars;
				section.limit = reported.limit;
				section.drafts = {};
				section.removed = [];
				section.additions = [];
			}
		}
		/**
		* Split a failed request into the HTTP status and any server-supplied text.
		* @param error - the thrown value.
		* @returns the status (null when the request never reached the API) and detail.
		*/
		function describeFailure(error) {
			if (error instanceof MemoryHttpError) return {
				status: error.status,
				detail: null
			};
			return {
				status: null,
				detail: error instanceof Error ? error.message : null
			};
		}
		/**
		* MemoryEditor controller: owns the memory API transport, the staged edits,
		* and the published snapshot. Created once per plugin lifecycle in apply();
		* dispose() stops in-flight responses from publishing.
		*/
		var MemoryController = class {
			/** The published editor snapshot (components read it through `useMemory`). */
			store;
			fetchImpl;
			disposed = false;
			/**
			* @param store - the shared editor store created at register.
			* @param opts - test seams (fetch).
			*/
			constructor(store, opts = {}) {
				this.fetchImpl = (opts.fetchImpl ?? fetch).bind(globalThis);
				this.store = store;
			}
			/** Stop publishing; an in-flight response is discarded when it settles. */
			dispose() {
				this.disposed = true;
			}
			/** Read both targets' entries and usage, replacing every staged edit. */
			async load() {
				this.store.update((draft) => {
					draft.phase = "loading";
					draft.notice = null;
				});
				try {
					const report = await this.request(STATE_ROUTE, { method: "GET" });
					if (this.disposed) return;
					this.store.update((draft) => {
						adoptReport(draft, report, MEMORY_TARGETS);
						draft.phase = "ready";
						draft.notice = null;
					});
				} catch (error) {
					this.fail(error, true);
				}
			}
			/**
			* Post one target's staged operations. A section with no staged change
			* saves nothing; an accepted write adopts the snapshot the API returned.
			* @param target - section to write.
			*/
			async save(target) {
				const operations = pendingOperations(this.store.getSnapshot().sections[target]);
				if (operations.length === 0) {
					this.store.update((draft) => {
						draft.notice = { kind: "unchanged" };
					});
					return;
				}
				this.store.update((draft) => {
					draft.notice = null;
					draft.saving = target;
				});
				try {
					const report = await this.request(WRITE_ROUTE, {
						method: "POST",
						body: JSON.stringify({
							target,
							operations
						}),
						json: true
					});
					if (this.disposed) return;
					this.store.update((draft) => {
						if (!report.ok && report.snapshot !== void 0) adoptReport(draft, report.snapshot, [target]);
						if (report.ok) {
							adoptReport(draft, report.snapshot, [target]);
							draft.phase = "ready";
						}
						draft.saving = null;
						draft.notice = report.ok ? {
							kind: "saved",
							detail: report.note === "" ? null : report.note
						} : {
							kind: "failed",
							status: null,
							detail: report.message
						};
					});
				} catch (error) {
					this.fail(error, false);
				}
			}
			/**
			* Record one entry's draft text.
			* @param target - owning section.
			* @param index - loaded entry index.
			* @param text - draft text.
			*/
			setDraft(target, index, text) {
				this.store.update((draft) => {
					draft.sections[target].drafts[index] = text;
				});
			}
			/**
			* Stage one loaded entry for removal.
			* @param target - owning section.
			* @param index - loaded entry index.
			*/
			removeEntry(target, index) {
				this.store.update((draft) => {
					const section = draft.sections[target];
					if (!section.removed.includes(index)) section.removed.push(index);
				});
			}
			/**
			* Undo a staged removal.
			* @param target - owning section.
			* @param index - loaded entry index.
			*/
			restoreEntry(target, index) {
				this.store.update((draft) => {
					const section = draft.sections[target];
					section.removed = section.removed.filter((candidate) => candidate !== index);
				});
			}
			/**
			* Stage a new entry. Blank text stages nothing.
			* @param target - owning section.
			* @param text - entry text.
			*/
			addEntry(target, text) {
				const content = text.trim();
				if (content === "") return;
				this.store.update((draft) => {
					draft.sections[target].additions.push(content);
				});
			}
			/**
			* Drop one staged addition.
			* @param target - owning section.
			* @param index - staged addition index.
			*/
			dropAddition(target, index) {
				this.store.update((draft) => {
					draft.sections[target].additions.splice(index, 1);
				});
			}
			/** Send one request and decode its JSON body. */
			async request(route, init) {
				const headers = { [MEMORY_HEADER]: MEMORY_HEADER_VALUE };
				if (init.json === true) headers["content-type"] = "application/json";
				const response = await this.fetchImpl(route, {
					method: init.method,
					headers,
					...init.body === void 0 ? {} : { body: init.body }
				});
				if (!response.ok) throw new MemoryHttpError(response.status);
				return await response.json();
			}
			/** Publish the banner for a failed request. */
			fail(error, loading) {
				if (this.disposed) return;
				const failure = describeFailure(error);
				this.store.update((draft) => {
					if (loading) draft.phase = "error";
					draft.saving = null;
					draft.notice = {
						kind: "failed",
						status: failure.status,
						detail: failure.detail
					};
				});
			}
		};
		//#endregion
		//#region \0dsh-css:G:\work\dsh-mem\ui-memory\src\client\MemoryView.module.css.mjs
		const css = ".EI-KSq_root{box-sizing:border-box;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);flex-direction:column;flex:1 1 0;display:flex}.EI-KSq_header{border-bottom:.5px solid var(--dsw-alias-border-l1);align-items:center;gap:12px;padding:8px 14px;display:flex}.EI-KSq_title{color:var(--dsw-alias-brand-primary);white-space:nowrap;text-overflow:ellipsis;flex:1;font-weight:600;overflow:hidden}.EI-KSq_status{color:var(--dsw-alias-label-tertiary);margin:0;padding:6px 14px;font-size:12px}.EI-KSq_noticeOk,.EI-KSq_noticeNeutral,.EI-KSq_noticeError{border-bottom:.5px solid var(--dsw-alias-border-l1);margin:0;padding:6px 14px;font-size:12px}.EI-KSq_noticeOk{color:var(--dsw-alias-state-success-primary)}.EI-KSq_noticeNeutral{color:var(--dsw-alias-label-tertiary)}.EI-KSq_noticeError{color:var(--dsw-alias-state-error-primary)}.EI-KSq_detail{color:var(--dsw-alias-label-secondary);margin-left:8px}.EI-KSq_sections{flex-direction:column;flex:1;gap:14px;min-height:0;padding:12px 14px;display:flex;overflow-y:auto}.EI-KSq_section{border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:8px;flex-direction:column;gap:8px;padding:10px 12px;display:flex}.EI-KSq_sectionHead{align-items:baseline;gap:10px;display:flex}.EI-KSq_sectionTitle{margin:0;font-size:13px;font-weight:600}.EI-KSq_usage{color:var(--dsw-alias-label-tertiary);font-size:12px}.EI-KSq_empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px}.EI-KSq_entries{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}.EI-KSq_entry{align-items:flex-start;gap:8px;display:flex}.EI-KSq_entryRemoved,.EI-KSq_pendingRow{align-items:center;gap:8px;display:flex}.EI-KSq_entryRemoved{opacity:.6}.EI-KSq_textarea{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-width:0;color:var(--dsw-alias-label-primary);font:inherit;resize:vertical;border-radius:6px;flex:1;padding:6px 8px;font-size:12px;line-height:1.5}.EI-KSq_textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.EI-KSq_pendingTag{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 6px;font-size:11px}.EI-KSq_pendingText{white-space:nowrap;text-overflow:ellipsis;min-width:0;color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;overflow:hidden}.EI-KSq_addRow{align-items:flex-start;gap:8px;display:flex}.EI-KSq_actions{justify-content:flex-end;display:flex}";
		const tagId = "@deepseek-ai/dsh-client-ui-memory/src/client/MemoryView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-memory";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var MemoryView_module_css_default = {
			"sectionHead": "EI-KSq_sectionHead",
			"pendingTag": "EI-KSq_pendingTag",
			"noticeNeutral": "EI-KSq_noticeNeutral",
			"sectionTitle": "EI-KSq_sectionTitle",
			"usage": "EI-KSq_usage",
			"entryRemoved": "EI-KSq_entryRemoved",
			"header": "EI-KSq_header",
			"status": "EI-KSq_status",
			"root": "EI-KSq_root",
			"addRow": "EI-KSq_addRow",
			"sections": "EI-KSq_sections",
			"entries": "EI-KSq_entries",
			"detail": "EI-KSq_detail",
			"noticeError": "EI-KSq_noticeError",
			"pendingRow": "EI-KSq_pendingRow",
			"title": "EI-KSq_title",
			"noticeOk": "EI-KSq_noticeOk",
			"entry": "EI-KSq_entry",
			"section": "EI-KSq_section",
			"empty": "EI-KSq_empty",
			"actions": "EI-KSq_actions",
			"pendingText": "EI-KSq_pendingText",
			"textarea": "EI-KSq_textarea"
		};
		//#endregion
		//#region src/client/MemoryView.tsx
		/**
		* The memory conversation-view tab: one section per editable target, each
		* listing that target's entries, its character usage, and the edits staged for
		* the next save. The view reads the shared editor snapshot through the
		* `useMemory` hook the renderer binds from the inject `hooks` compartment and
		* drives the controller through the injected callbacks — no ctx, no
		* subscriptions of its own.
		*/
		/** Section titles, in section order. */
		const SECTION_TITLE = {
			user: "section.user",
			memory: "section.memory"
		};
		/** Exhaustiveness guard for the closed notice union. */
		function assertNever(value) {
			throw new Error(`unhandled memory notice: ${JSON.stringify(value)}`);
		}
		/**
		* Render the memory editor page for both targets.
		* @param props - view props (framework kit, injected face, locale seat).
		*/
		function MemoryView(props) {
			const { useMemory, t, load, save, setDraft, removeEntry, restoreEntry, addEntry, dropAddition } = props;
			const snapshot = useMemory((state) => state);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: MemoryView_module_css_default.root,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: MemoryView_module_css_default.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MemoryView_module_css_default.title,
							children: t("view.memory")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							disabled: snapshot.phase === "loading",
							onClick: load,
							children: t("actions.reload")
						})]
					}),
					snapshot.notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
						notice: snapshot.notice,
						t
					}),
					snapshot.phase !== "ready" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: MemoryView_module_css_default.status,
						children: t(snapshot.phase === "loading" ? "status.loading" : "status.loadFailed")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: MemoryView_module_css_default.sections,
						children: MEMORY_TARGETS.map((target) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemorySection, {
							title: t(SECTION_TITLE[target]),
							t,
							section: snapshot.sections[target],
							saving: snapshot.saving === target,
							onSave: () => {
								save(target);
							},
							onDraft: (index, text) => {
								setDraft(target, index, text);
							},
							onRemove: (index) => {
								removeEntry(target, index);
							},
							onRestore: (index) => {
								restoreEntry(target, index);
							},
							onAdd: (text) => {
								addEntry(target, text);
							},
							onDropAddition: (index) => {
								dropAddition(target, index);
							}
						}, target))
					})
				]
			});
		}
		/** Outcome banner of the most recent request. */
		function Notice({ notice, t }) {
			switch (notice.kind) {
				case "saved": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: MemoryView_module_css_default.noticeOk,
					role: "status",
					children: [t("notice.saved"), notice.detail !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: MemoryView_module_css_default.detail,
						children: notice.detail
					})]
				});
				case "unchanged": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: MemoryView_module_css_default.noticeNeutral,
					role: "status",
					children: t("notice.unchanged")
				});
				case "failed": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: MemoryView_module_css_default.noticeError,
					role: "alert",
					children: [t("notice.failed"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: MemoryView_module_css_default.detail,
						children: notice.detail ?? (notice.status === null ? "" : t("notice.status", { status: notice.status }))
					})]
				});
				default: return assertNever(notice);
			}
		}
		/** One target's section: usage, loaded entries, staged additions, and save. */
		function MemorySection(props) {
			const { title, t, section, saving, onSave, onDraft, onRemove, onRestore, onAdd, onDropAddition } = props;
			const [draft, setDraft] = (0, react.useState)("");
			const staged = pendingOperations(section).length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: MemoryView_module_css_default.section,
				"aria-label": title,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: MemoryView_module_css_default.sectionHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: MemoryView_module_css_default.sectionTitle,
							children: title
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MemoryView_module_css_default.usage,
							children: t("usage.text", {
								chars: section.chars,
								limit: section.limit
							})
						})]
					}),
					section.entries.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: MemoryView_module_css_default.empty,
						children: t("entries.empty")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
						className: MemoryView_module_css_default.entries,
						children: [section.entries.map((text, index) => {
							const removed = section.removed.includes(index);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								className: removed ? MemoryView_module_css_default.entryRemoved : MemoryView_module_css_default.entry,
								children: removed ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: MemoryView_module_css_default.pendingTag,
										children: t("entry.removed")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: MemoryView_module_css_default.pendingText,
										children: text
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "ghost",
										size: "sm",
										onClick: () => {
											onRestore(index);
										},
										children: t("entry.undo")
									})
								] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: MemoryView_module_css_default.textarea,
									"aria-label": t("entry.editorLabel"),
									rows: 2,
									value: section.drafts[index] ?? text,
									onChange: (event) => {
										onDraft(index, event.target.value);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									onClick: () => {
										onRemove(index);
									},
									children: t("entry.remove")
								})] })
							}, index);
						}), section.additions.map((content, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: MemoryView_module_css_default.pendingRow,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: MemoryView_module_css_default.pendingTag,
									children: t("entry.pendingAdd")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: MemoryView_module_css_default.pendingText,
									children: content
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									onClick: () => {
										onDropAddition(index);
									},
									children: t("entry.discard")
								})
							]
						}, `add-${index}`))]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: MemoryView_module_css_default.addRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: MemoryView_module_css_default.textarea,
							"aria-label": t("entry.addLabel"),
							placeholder: t("entry.addPlaceholder"),
							rows: 2,
							value: draft,
							onChange: (event) => {
								setDraft(event.target.value);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							disabled: draft.trim() === "",
							onClick: () => {
								onAdd(draft);
								setDraft("");
							},
							children: t("entry.add")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: MemoryView_module_css_default.actions,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: staged === 0 || saving,
							onClick: onSave,
							children: t(saving ? "actions.saving" : "actions.save")
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* `memory` namespace dictionaries: the view tab label plus the editor chrome.
		* The dictionary key set is the source of truth for both locales.
		*/
		const NS = "memory";
		/** zh-CN dictionary (product copy language). */
		const zh = {
			"view.memory": "记忆",
			"section.user": "用户档案",
			"section.memory": "记忆",
			"usage.text": "{chars} / {limit} 字符",
			"entries.empty": "暂无条目",
			"entry.editorLabel": "条目内容",
			"entry.removed": "待移除",
			"entry.remove": "移除",
			"entry.undo": "撤销",
			"entry.addLabel": "新增条目",
			"entry.addPlaceholder": "输入需要长期记住的内容…",
			"entry.add": "添加",
			"entry.pendingAdd": "待添加",
			"entry.discard": "丢弃",
			"actions.save": "保存",
			"actions.saving": "保存中…",
			"actions.reload": "重新加载",
			"status.loading": "正在读取记忆…",
			"status.loadFailed": "无法读取记忆",
			"notice.saved": "已保存",
			"notice.unchanged": "没有需要保存的改动",
			"notice.failed": "请求失败",
			"notice.status": "HTTP {status}"
		};
		/** en dictionary. */
		const en = {
			"view.memory": "Memory",
			"section.user": "User profile",
			"section.memory": "Memory",
			"usage.text": "{chars} / {limit} characters",
			"entries.empty": "No entries yet",
			"entry.editorLabel": "Entry text",
			"entry.removed": "Marked for removal",
			"entry.remove": "Remove",
			"entry.undo": "Undo",
			"entry.addLabel": "New entry",
			"entry.addPlaceholder": "Type what should be remembered…",
			"entry.add": "Add",
			"entry.pendingAdd": "Pending addition",
			"entry.discard": "Discard",
			"actions.save": "Save",
			"actions.saving": "Saving…",
			"actions.reload": "Reload",
			"status.loading": "Loading memory…",
			"status.loadFailed": "Could not load memory",
			"notice.saved": "Saved",
			"notice.unchanged": "Nothing to save",
			"notice.failed": "Request failed",
			"notice.status": "HTTP {status}"
		};
		//#endregion
		//#region src/client/index.ts
		/** Required services: the conversation slot and the locale service. */
		const inject = ["slots", "locale"];
		/**
		* Client plugin body: create the editor controller, register the locale
		* dictionaries, and add the memory view tab. Plugin unload disposes the
		* registration and stops the controller publishing further responses.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-memory: dictionaries");
			const t = ctx.locale.bind(NS);
			const store = createMemoryStore();
			const controller = new MemoryController(store);
			ctx.effect(() => () => {
				controller.dispose();
			}, "ui-memory: controller lifecycle");
			controller.load();
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "memory",
				order: 15,
				locale: NS,
				label: () => t("view.memory"),
				inject: () => ({
					hooks: { memory: store },
					load: () => {
						controller.load();
					},
					save: (target) => {
						controller.save(target);
					},
					setDraft: (target, index, text) => {
						controller.setDraft(target, index, text);
					},
					removeEntry: (target, index) => {
						controller.removeEntry(target, index);
					},
					restoreEntry: (target, index) => {
						controller.restoreEntry(target, index);
					},
					addEntry: (target, text) => {
						controller.addEntry(target, text);
					},
					dropAddition: (target, index) => {
						controller.dropAddition(target, index);
					}
				})
			}, MemoryView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map