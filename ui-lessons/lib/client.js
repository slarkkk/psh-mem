window.__ModuleLoader__.load({
	id: '@deepseek-ai/dsh-client-ui-lessons',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;
		const { useEffect, useMemo, useState } = React;

		/** 与 lessons 主机插件的三条路由约定的请求头。 */
		const HEADER = { 'x-dsh-lessons': '1' };

		const styles = {
			root: {
				display: 'flex', flexDirection: 'column', gap: 10, height: '100%',
				overflowY: 'auto', padding: '14px 18px', boxSizing: 'border-box',
				fontSize: 13, lineHeight: 1.5,
			},
			header: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
			title: { margin: 0, fontSize: 15, fontWeight: 600 },
			row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
			muted: { opacity: 0.65, fontSize: 12 },
			button: {
				padding: '2px 10px', borderRadius: 6, border: '1px solid rgba(127,127,127,.45)',
				background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12,
			},
			chip: {
				padding: '0 8px', borderRadius: 999, border: '1px solid currentColor',
				fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap',
			},
			chipButton: {
				padding: '0 8px', borderRadius: 999, border: '1px solid rgba(127,127,127,.35)',
				background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12,
				lineHeight: '18px',
			},
			chipActive: {
				padding: '0 8px', borderRadius: 999, border: '1px solid currentColor',
				background: 'rgba(127,127,127,.18)', color: 'inherit', cursor: 'pointer',
				fontSize: 12, lineHeight: '18px',
			},
			item: {
				border: '1px solid rgba(127,127,127,.25)', borderRadius: 8,
				padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
			},
			itemHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
			message: { margin: 0, wordBreak: 'break-word' },
			id: { opacity: 0.5, fontSize: 11, fontFamily: 'ui-monospace, monospace' },
			group: { display: 'flex', flexDirection: 'column', gap: 8 },
		};

		async function callApi(path, init) {
			const response = await fetch(path, init);
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				const detail = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
				throw new Error(detail);
			}
			return body;
		}

		function TagChip(props) {
			return h('span', { style: { ...styles.chip, opacity: 0.8 } }, props.text);
		}

		function LessonItem(props) {
			const { lesson, busy, onConfirm, onForget } = props;
			return h('div', { style: styles.item },
				h('div', { style: styles.itemHead },
					h('span', { style: styles.id }, '#', lesson.id),
					h('span', { style: { fontWeight: 600 } }, lesson.title),
					lesson.stale === true && h('span', {
						style: { ...styles.chip, color: '#f5a524', borderColor: '#f5a524' },
					}, `过期 ${lesson.ageDays} 天`),
					h('span', { style: { flex: 1 } }),
					h('button', { style: styles.button, disabled: busy, onClick: () => onConfirm(lesson.id) }, '仍然成立'),
					h('button', { style: styles.button, disabled: busy, onClick: () => onForget(lesson.id) }, '删除'),
				),
				lesson.symptom !== undefined && h('p', { style: { ...styles.message, ...styles.muted } }, `现象：${lesson.symptom}`),
				lesson.cause !== undefined && h('p', { style: { ...styles.message, ...styles.muted } }, `根因：${lesson.cause}`),
				h('p', { style: styles.message }, `做法：${lesson.fix}`),
				h('div', { style: styles.row },
					(lesson.tags || []).map(tag => h(TagChip, { key: `t-${tag}`, text: tag })),
					(lesson.paths || []).map(path => h(TagChip, { key: `p-${path}`, text: path })),
					h('span', { style: styles.muted }, `命中 ${lesson.hits} 次 · ${lesson.ageDays} 天前确认 · ${lesson.scope === 'global' ? '全局' : '工作区'}`),
				),
			);
		}

		/** 「教训」页：读 /lessons/state，写 /lessons/confirm、/lessons/forget。 */
		function LessonsView() {
			const [report, setReport] = useState(null);
			const [phase, setPhase] = useState('loading');
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);
			const [tag, setTag] = useState(null);
			const [busy, setBusy] = useState(false);

			async function load() {
				setPhase('loading');
				try {
					const next = await callApi('/lessons/state', { headers: HEADER });
					setReport(next);
					setError(null);
					setPhase('ready');
				} catch (failure) {
					setError(String(failure && failure.message ? failure.message : failure));
					setPhase(report === null ? 'error' : 'ready');
				}
			}

			useEffect(() => { void load(); }, []);

			async function mutate(path, id, label) {
				setBusy(true);
				setNotice(null);
				try {
					await callApi(path, {
						method: 'POST',
						headers: { ...HEADER, 'content-type': 'application/json' },
						body: JSON.stringify({ id }),
					});
					setNotice(label);
					await load();
				} catch (failure) {
					setNotice(`操作失败：${failure && failure.message ? failure.message : failure}`);
				} finally {
					setBusy(false);
				}
			}

			const lessons = report === null ? [] : report.lessons;
			const tags = useMemo(() => {
				const counts = new Map();
				for (const lesson of lessons) for (const item of lesson.tags || []) counts.set(item, (counts.get(item) || 0) + 1);
				return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12);
			}, [report]);
			const shown = lessons.filter(lesson => lesson.archived !== true && (tag === null || (lesson.tags || []).includes(tag)));
			const counts = report === null ? { total: 0, stale: 0, hits: 0 } : report.counts;

			return h('div', { style: styles.root },
				h('div', { style: styles.header },
					h('h3', { style: styles.title }, '教训'),
					report !== null && h('span', { style: styles.muted }, report.workspace),
					h('span', { style: { flex: 1 } }),
					h('button', { style: styles.button, disabled: phase === 'loading', onClick: () => { void load(); } },
						phase === 'loading' ? '加载中…' : '刷新'),
				),
				report !== null && h('div', { style: styles.row },
					h('span', { style: styles.chip }, `共 ${counts.total} 条`),
					counts.stale > 0 && h('span', { style: { ...styles.chip, color: '#f5a524', borderColor: '#f5a524' } }, `过期 ${counts.stale}`),
					h('span', { style: styles.muted }, `累计命中 ${counts.hits} 次`),
				),
				error !== null && h('p', { style: { ...styles.muted, color: '#e5484d' } }, `读取失败：${error}`),
				notice !== null && h('p', { style: styles.muted }, notice),
				tags.length > 0 && h('div', { style: styles.row },
					h('button', { style: tag === null ? styles.chipActive : styles.chipButton, onClick: () => setTag(null) }, '全部'),
					tags.map(([name, count]) => h('button', {
						key: name,
						style: tag === name ? styles.chipActive : styles.chipButton,
						onClick: () => setTag(name),
					}, `${name} ${count}`)),
				),
				report !== null && shown.length === 0 && h('p', { style: styles.muted },
					lessons.length === 0
						? '还没有记录。一次非显然的失败被修复后，让模型用 lesson action=record 记一条。'
						: '没有匹配这个标签的教训。'),
				h('div', { style: styles.group },
					shown.map(lesson => h(LessonItem, {
						key: lesson.id,
						lesson,
						busy,
						onConfirm: id => { void mutate('/lessons/confirm', id, '已确认仍然成立。'); },
						onForget: id => {
							if (window.confirm('删除这条教训？删除后不会再自动提醒。')) void mutate('/lessons/forget', id, '已删除。');
						},
					})),
				),
			);
		}

		/** 浏览器插件体：把本页注册成会话视图的一个 tab。 */
		function apply(ctx) {
			ctx.slots.inject('conversation.view', () => ctx.slots.register({
				name: 'conversation.view',
				id: 'lessons',
				order: 17,
				label: () => '教训',
				inject: () => ({}),
			}, LessonsView));
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		return module.exports;
	},
});
