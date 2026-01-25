// MAIN NAVIGATION MENU ---
// Displays the primary menu panel with city selection and core account actions.
// Allows users to update city filters, access profile setup, or create events.
import { useNavigate } from 'react-router-dom';
import { useState, memo, useEffect } from 'react';
import LocationPicker from '../LocationPicker';
import { areEqual } from '../../../helpers';

/** Bottom menu panel for city selection, setup/editor shortcuts and logout */
function Menu(props) {
	const navigate = useNavigate();
	const { brain, logOut, changeCities, setMenuView, nowAt, menuView } = props;
	const [curSelCities, setCurSelCities] = useState(() => [...brain.user.curCities]);

	// CITY FILTER SYNC ---------------------------
	const citiesChanged =
		curSelCities.length > 0 &&
		!areEqual(
			[...brain.user.curCities].sort((a, b) => a - b),
			curSelCities.map(c => c.cityID || c).sort((a, b) => a - b)
		);

	useEffect(() => {
		setCurSelCities([...brain.user.curCities]);
	}, [brain.user.curCities, menuView]);

	return (
		<main-menu class={`${menuView !== 'menu' ? 'hide' : ''} boRadM textAli       bgTransXxs    fPadHorXxs flexCol `}>
			<span className="fs35 xBold marBotM textSha marTopXxl">Hlavní menu</span>

			{/* CITY SELECTION --------------------------- */}
			<LocationPicker brain={brain} curSelCities={curSelCities} setCurSelCities={setCurSelCities} changeCities={changeCities} inMenu={true} />

			{/* CORE ACTIONS --------------------------- */}
			<bottom-row class="flexCen  growAll spaceBet marBotXs  w100 mw130 imw5 hvw6 mh6  marAuto ">
				{/* SETUP LINK --------------------------- */}
				<button
					className="   fs6 w20 miw8 mw14 hvw10 mh8 padVerXxs flexCol aliCen bold justCen  borderLight  bHover"
					onClick={() => {
						nowAt !== 'setup' && navigate('setup');
					}}>
					<img src="/icons/settings.png" alt="" className="aspect1612 w35 mh3-5" />
					Nastavit
				</button>

				{/* CREATE EVENT OR CONFIRM CITIES --------------------------- */}
				<button
					onClick={() => {
						if (citiesChanged) {
							setMenuView('');
							changeCities(curSelCities);
						} else nowAt === 'editor' ? setMenuView('') : navigate('editor');
					}}
					className={` shaTop w100  ${citiesChanged ? 'bPurple' : 'bDarkGreen'} tWhite zinMax mw100 borderTop fs22 tSha10 xBold boRadXs hvw8 mh6 marAuto`}>
					{citiesChanged ? 'Potvrdit změnu měst' : 'Vytvořit událost'}
				</button>

				{/* LOGOUT --------------------------- */}
				<button
					className="   w20 mw14 hvw10 mh8 padVerXxs    flexCol fs6   justCen bold aliCen  borderLight  bHover"
					onClick={() => {
						(setMenuView(false), logOut());
					}}>
					<img src="/icons/logout.png" alt="" className="aspect1610 w50 mh3-5" />
					Odhlásit
				</button>
			</bottom-row>
		</main-menu>
	);
}

// RENDER OPTIMIZATION ---------------------------
function dontRerender(prevProps, nextProps) {
	return prevProps.menuView === nextProps.menuView && areEqual(prevProps.brain.user.curCities, nextProps.brain.user.curCities);
}

export default memo(Menu, dontRerender);
