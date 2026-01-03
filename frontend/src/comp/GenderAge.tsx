const GenderAge = ({ data, superMan, avail, nowAt, inform }) => {
	const { minAge, maxAge, gender } = data;
	const { minAge: minAvail, maxAge: maxAvail, genders } = avail;
	let [newMax, newMin] = [(maxAge || maxAvail).toString(), (minAge || minAvail).toString()];

	const man = (inp, val, blur = false) => {
		if (inp === 'minAge') {
			if (blur) return superMan(inp, val);
			else if (val.length === minAvail.toString().length && Number(val) < Number(minAvail) && Number(val) > Number(newMax.slice(0, val.length))) val = minAvail;
			else if (val.length >= newMax.length && Number(val) > Number(newMax)) val = minAvail;

			superMan(inp, val);
		} else if (inp === 'maxAge') {
			if (blur) return superMan(inp, val);
			else if (val.length >= maxAvail.length && Number(val) > Number(maxAvail)) val = maxAvail;
			else if (val.length === newMin.length && Number(val) < Number(newMin) && Number(val) > Number(maxAvail.toString().slice(0, val.length))) val = maxAvail;
			else if (val > maxAvail) val = maxAvail;
			superMan(inp, val);
		} else superMan(inp, val);
	};

	return (
		<gender-age class='flexCen marAuto marBotL   posRel bw20 growAll  '>
			{/* GENDER BS */}
			<gender-bs class='  flexRow  shaBlue    mw60 boRadS growAll'>
				{/* MALE GENDER */}
				<button
					disabled={!gender && !genders.includes('m')}
					onClick={() => man('gender', 'm')}
					className={`${gender === 'm' && !genders.includes('m') ? 'bRed tWhite' : gender === 'm' ? 'bBlue tWhite' : ''} hr4 boldXs bHover  fsC `}>
					muž
				</button>
				{/* MIN AGE INPUT*/}
				<input
					className={`${minAge ? 'bBlue bold tWhite' : ''} w14 bSel hr4 mw14 fsB`}
					onInput={e => {
						let val = e.target.value.replace(/[^0-9]/g, '').replace(/^0+/, '');
						man('minAge', val, false);
					}}
					onBlur={e => {
						let val = e.target.value.replace(/[^0-9]/g, '').replace(/^0+/, '');
						if (val && val < newMin) man('minAge', newMin, true);
						else if (val > newMax) man('minAge', null, true);
					}}
					value={minAge || ''}
					type='number'
					min={nowAt === 'home' ? minAvail : new Date().getFullYear() - 100}
					placeholder={`${isFinite(minAvail) ? minAvail : 0} až`}
					disabled={!minAge && !isFinite(minAvail)}
				/>
				{/* MAX AGE INPUT */}
				{nowAt === 'home' && (
					<input
						className={`${maxAge ? 'bBlue bold tWhite' : ''} w14 bSel hr4 mw14 fsB`}
						onInput={e => {
							let val = e.target.value.replace(/[^0-9]/g, '').replace(/^0+/, '');
							man('maxAge', val, false);
						}}
						onBlur={e => {
							let val = e.target.value.replace(/[^0-9]/g, '').replace(/^0+/, '');
							if (val && val > newMax) man('maxAge', newMax, true);
							else if (val && val < newMin) man('maxAge', null, true);
						}}
						value={maxAge || ''}
						type='number'
						placeholder={`${isFinite(maxAvail) ? maxAvail : 0} let`}
						disabled={!maxAge && !isFinite(maxAvail)}
					/>
				)}
				{/* FEMALE GENDER */}
				<button
					disabled={!gender && !genders.includes('f')}
					onClick={() => man('gender', 'f')}
					className={`${gender === 'f' && !genders.includes('f') ? 'bRed tWhite' : gender === 'f' ? 'bBlue tWhite' : ''}  hr4 boldXs bHover  fsC `}>
					žena
				</button>
			</gender-bs>
		</gender-age>
	);
};

export default GenderAge;
