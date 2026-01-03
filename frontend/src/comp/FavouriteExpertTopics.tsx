import { useState, useRef, useEffect, useContext } from 'react';
import { globalContext } from '../contexts/globalContext';
import { MAX_CHARS, REGEXES } from '../../../shared/constants';

function FavouriteExpertTopics(p: any) {
	const { isMobile } = useContext(globalContext);
	const { data = {} as any, superMan, inform, setInform } = p || {};
	// FAVEX LIMITS ---------------------------------------------------------------
	// Total char limit across BOTH categories (favs + exps) mirrors backend sanitizer
	const charsLimit = MAX_CHARS.favourExpertTopics;
	const [inputValue, setInputValue] = useState('');
	const [editing, setEditing] = useState({ cat: null, i: null });
	const [editingValue, setEditingValue] = useState('');
	const inputRef = useRef(null),
		editInputRef = useRef(null),
		textMeasureRef = useRef(null);
	const [inputWarn, setInputWarn] = useState([]);
	const informSrc = { top: ['tooShort', 'duplicate', 'tooLong', 'noTopic', 'invalidTopic'], bottom: ['notSpecific', 'shortWords'] };

	// MANAGER FUNCTION ------------------------------------------------------------
	const man = (a, c, i = null) => {
		setInputWarn([]);
		const arr = [...(data[c] || [])];
		const getFavexTotalChars = (override: any = {}) => {
			const favs = override.favs ?? data.favs ?? [];
			const exps = override.exps ?? data.exps ?? [];
			return [...favs, ...exps].reduce((total, topic) => total + String(topic || '').length, 0);
		};

		const validateTopic = (val, ignoreIndex = -1) => {
			if (val.length < 3) return ['tooShort'];
			if (!REGEXES.favouriteExpertTopic.test(val)) return ['invalidTopic'];
			if (arr.some((k, x) => x !== ignoreIndex && k.toLowerCase() === val.toLowerCase())) return ['duplicate'];
			const oldLen = ignoreIndex !== -1 ? String(arr[ignoreIndex] || '').length : 0;
			if (getFavexTotalChars() - oldLen + val.length > charsLimit) return ['tooLong'];
			return [];
		};

		if (a === 'del') {
			return superMan(
				c,
				arr.filter((_, x) => x !== i)
			);
		} else if (a === 'addTopic') {
			const v = inputValue.trim();
			if (!editInputRef.current && v.length === 0) return setInputWarn(['noTopic']);
			const warns = validateTopic(v);
			if (warns.length) return setInputWarn(warns);

			const isMostlyUppercase = str => str.split('').filter(char => char === char.toUpperCase() && char !== char.toLowerCase()).length / str.length > 0.8;
			arr.push(isMostlyUppercase(v) && v.length > 5 ? v.toLowerCase() : v);
			setInputValue('');
		} else if (a === 'editTopic') {
			const v = editingValue.trim();
			if (!v) {
				setEditing({ cat: null, i: null });
				return;
			}
			const warns = validateTopic(v, i);
			if (warns.length) return setInputWarn(warns);

			arr[i] = v;
			setEditing({ cat: null, i: null });
		}
		superMan(c, arr);
		setInputValue('');
		if (!isMobile) inputRef.current.focus({ preventScroll: true }); // SKIP AUTOFOCUS ON MOBILE ---------------------------
	};
	const handleKeyPress = (e, c, i) => {
		if (e.key === 'Enter') {
			if (!editingValue.trim()) setEditing({ cat: null, i: null });
			else man('editTopic', c, i);
		}
	};
	useEffect(() => {
		if (editInputRef.current && !isMobile) editInputRef.current.focus({ preventScroll: true }); // SKIP AUTOFOCUS ON MOBILE ---------------------------
	}, [editing, isMobile]);
	useEffect(() => {
		if (textMeasureRef.current) {
			textMeasureRef.current.textContent = editingValue || '';
			if (editInputRef.current) editInputRef.current.style.width = `${textMeasureRef.current.textContent.length * 8.4}px`;
		}
	}, [editingValue]);
	const somethingsWrong = ['notSpecific', 'shortWords', 'addFavs'].some(z => inform.includes(z)) || inputWarn.length > 0;
	const resetEditing = () => {
		setEditing({ cat: null, i: null });
		setEditingValue('');
		setInputWarn([]);
	};
	const renderTopics = (topics, cat, colorClass) => (
		<div className='flexRow hr3 aliStretch marBotS wrap justCen '>
			<span className={`fs10 ${colorClass} textSha selfCen inlineBlock marRigS xBold`}>{cat === 'favs' ? 'Oblíbené:' : 'Expertní:'}</span>
			{topics.map((val, i) => (
				<div key={i} className={`${editing.cat === cat && editing.i === i ? 'bsContentGlow' : ''} sideBors borderBot marRigXxs boRadXxs flexRow`}>
					{editing.cat === cat && editing.i === i ? (
						<input
							ref={editInputRef}
							value={editingValue}
							placeholder={topics[i]}
							onChange={e => setEditingValue(e.target.value)}
							onKeyDown={e => handleKeyPress(e, cat, i)}
							className='shaBlue bHover w100 wAuto padHorXs h100 fs7 boldXs'
						/>
					) : (
						<button className='pointer  bHover shaBlue h100 bHover padHorS fs7 boldXs' onClick={() => man('del', cat, i)}>
							{val}
						</button>
					)}
					<button
						className={`${editing.cat === cat && editing.i === i ? 'tGreen' : 'tOrange'} bGlassSubtle bold bHover fs8 h100 padHorXs`}
						onClick={() => {
							if (editing.cat === cat && editing.i === i) man('editTopic', cat, i);
							else {
								setEditing({ cat: cat, i: i });
								setEditingValue(val);
							}
						}}>
						<img
							className={'mw2 mih2'}
							src={`/icons/${editing.cat === cat && editing.i === i ? 'surely.png' : 'edit.png'}`}
							alt={editing.cat === cat && editing.i === i ? 'confirm' : 'edit'}
						/>
					</button>
				</div>
			))}
		</div>
	);

	return (
		<div className='marAuto wrap justCen fPadHorS labelM w100'>
			{data.id && (
				<title-texts>
					<span className='xBold marBotXxs inlineBlock fs15'>Vlastní témata</span>
					<p className='fs8 marBotXs mw160 lh1 marAuto'>
						Zadej alespoň 2 oblíbená konverzační témata a nebo odborná témata, v nichž rád obohatíš ostatní. Pro obě kategorie dohromady je maximální počet znaků {charsLimit}.
					</p>
					{[...(data.favs || []), ...(data.exps || [])].reduce((t, u) => t + String(u || '').length, 0) >= charsLimit && (
						<span className='fs10 tRed xBold inlineBlock'>Dosažen maximální počet znaků</span>
					)}
				</title-texts>
			)}
			{!somethingsWrong && <blue-divider className='hr0-3 borTop block bInsetBlueTopXl borTop opacityM bgTrans posRel w100  borTop marAuto' />}
			<input
				ref={inputRef}
				value={inputValue}
				onFocus={() => {
					setInputWarn([]);
					resetEditing();
				}}
				onKeyDown={e => e.key === 'Enter' && man('addTopic', 'favs')}
				onChange={e => {
					setInputValue(e.target.value.replace(/^\s+/, '').replace(/\|/g, ''));
					if (inputWarn.length > 0) setInputWarn([]);
					if (inform.length > 0) setInform([]);
				}}
				className={`${somethingsWrong ? 'borderRed' : ''} padAllS  arrowDown1 posRel fs12 bold grow shaComment textAli hr5 w100`}
				placeholder='Zadej oblíbené či expertní téma ...'
				maxLength={200}
			/>
			{informSrc.top.some(m => inputWarn.includes(m)) && (
				<input-warnings className='marTopXxs marBotXxs block'>
					{inputWarn.map((m, i) => (
						<span key={i} className='tRed fs8 bold'>
							{m === 'noTopic' && 'Nejdříve zadej téma'}
							{m === 'invalidTopic' && 'První slovo nesmí obsahovat symbol.'}
							{m === 'tooShort' && 'Téma musí mít alespoň 3 znaky.'}
							{m === 'duplicate' && 'Toto téma už máš zadané.'}
							{m === 'tooLong' && 'Témata dohromady mohou mít max.200 znaků.'}
							{i < inputWarn.length - 1 ? ' + ' : ''}
						</span>
					))}
				</input-warnings>
			)}
			{!somethingsWrong && <blue-divider className='hr0-5 borTop block bInsetBlueTopXl borTop bgTrans posRel w100 marBotXs mw120 borTop marAuto' />}
			{data.id && inform.includes('addFavs') && <span className='tRed fs8 marTopXxs inlineBlock xBold'>zadej alespoň 2 oblíbená konverzační témata</span>}
			{data.favs?.length >= 2 && !inform.includes('addFavs') && informSrc.bottom.some(w => inform.includes(w)) && (
				<topic-warnings>
					{inform.map((m, i) => (
						<span key={i} className='tRed marRigXs xBold fs8 marTopXs lh1 inlineBlock aliCen'>
							{m === 'notSpecific' && 'Příliš mnoho jednoslovných témat. Zadej je kvalitněji.'}
							{m === 'shortWords' && !inform.includes('notSpecific') && !inputWarn.includes('notSpecific') && 'témata obsahují příliš krátkých slov'}
							{i < inform.length - (['notSpecific', 'shortWords'].every(k => inform.includes(k)) ? 2 : 1) ? ' + ' : ''}
						</span>
					))}
				</topic-warnings>
			)}
			{inputValue.length > 1 && (
				<addtopic-buttons className='flexCen w100 borBot gapXxs bInsetBlueTop posRel mw140 marAuto bw50'>
					<button className='posRel shaBlue borderBot borTop tBlue w80 padVerS marTopXxs boRadXxs miw10' onClick={() => man('addTopic', 'favs')}>
						<span className='fs10 lh1 tBlue xBold'>Přidat do OBLÍBENÝCH</span>
						<span className='fsA lh1 tDarkBlue'>O tomhle si strašně rád povídáš</span>
					</button>
					<button className='posRel shaBlue borTop borderBot w80 padVerS marTopXxs boRadXxs miw10' onClick={() => man('addTopic', 'exps')}>
						<span className='fs10 lh1 tGreen xBold'>Přidat do EXPERTNÍCH</span>
						<span className='fsA lh1 tDarkGreen'>V tomhle jsi odborník a rád vzděláš druhé.</span>
					</button>
				</addtopic-buttons>
			)}
			{inputValue.length < 2 && [...(data.favs || []), ...(data.exps || [])].length > 0 && (
				<existing-topics className='flexInline justCen gapS w100 padTopXs wrap'>
					{data.favs?.length > 0 && renderTopics(data.favs, 'favs', 'tBlue')}
					{data.exps?.length > 0 && renderTopics(data.exps, 'exps', 'tGreen')}
				</existing-topics>
			)}
			<span ref={textMeasureRef} className='hide posAbs preWrap' />
		</div>
	);
}
export default FavouriteExpertTopics;
