import { useState, useEffect, memo } from 'react';

const FavexSearch = props => {
	const { clear } = props;
	const basicTopics = ['Slušné chování', 'Politika v ČR', 'Průmysl a technologie', 'Sociální kritika'];
	const advancedTopics = ['job', 'politics', 'economy', 'society'];
	const expertTopics = ['Nakládané okurky', 'Pejsci', 'Kočičky', 'Elektro motory'];
	const src = {
		names: ['Oblíbená', 'Expertní'],
		srcs: [advancedTopics, expertTopics],
		index: function (e) {
			return this.names.indexOf(e);
		},
	};
	// INIT catTypesStructure
	const catTypesStructure = {};
	for (const cat of src.names) {
		catTypesStructure[cat] = [];
	}
	const [selCat, setSelCat] = useState(src.names[0]);
	const [selFavex, setSelFavex] = useState(catTypesStructure);

	//MANAGER
	const man = (e: any, delFrom: any = undefined) => {
		e = e.target.closest('button').name;

		if (e === 'nonAll') {
			setSelFavex(catTypesStructure);
			return;
		}
		const origin = delFrom ? delFrom : selCat;
		const alreadyExists = selFavex[origin].includes(e);
		alreadyExists ? setSelFavex(prev => ({ ...prev, [origin]: prev[origin].filter(topic => topic !== e) })) : setSelFavex(prev => ({ ...prev, [selCat]: [...prev[selCat], e] }));
	};

	return (
		<favex-search class='flexCol mw180 marAuto marBotXl marTopXxxl aliCen'>
			<categories-bs class='flexCen w100 mw110  bw33 bPadXs growAll   shaBot iw100 imw12'>
				{/* MAIN 3 BS */}
				{src.names.map(cat => (
					<button className={`${selCat === cat ? 'blueGlass' : 'bGlass'} bSel bHover  w100 flexCol `} name={cat} key={cat} onClick={() => setSelCat(cat)}>
						<img className='blueGlass' src='/icons/placeholdergood.png' alt='' />
						<span className='boldM lh1 fsD'>{cat}</span>
					</button>
				))}
			</categories-bs>

			{/* SEARCH INPUT */}
			<div className='w100 padTopXxxs bInsetBlueTop borTop2'>
				<input className=' padTopXxs marAuto hr6 borderTop fsE w100 marBotXxs' type='text' placeholder='Vyhledej ve zvolené kategorii témat' />
			</div>

			<topics-bs class='flexCen mw170 fs8 bBoldS marAuto marBotXs wrap bPadXs'>
				{/* TOPICS BS */}
				{src.srcs[src.index(selCat)].map(topic => (
					<button name={topic} key={topic} onClick={man}>
						{topic}
					</button>
				))}
			</topics-bs>

			{/* B NONE-ALL */}
			<sel-topics class='flexCen mw160 marAuto wrap bhr4 opacityL bPadS'>
				{Object.values(selFavex).flat().length > 0 && (
					<button className=' fsE xBold ' name='nonAll' onClick={man}>
						⌧
					</button>
				)}

				{/* SEL TOPICS BS */}
				{Object.keys(selFavex).flatMap(cat =>
					selFavex[cat].map((topic, i) => {
						return (
							<button className='flexRow fsD' name={topic} key={topic} onClick={e => man(e, cat)}>
								<span>
									<strong className='fsD'>{i === 0 && cat.slice(0, 3) + ' '}</strong>
									{topic}
								</span>
							</button>
						);
					})
				)}
			</sel-topics>
		</favex-search>
	);
};

export default memo(FavexSearch);
