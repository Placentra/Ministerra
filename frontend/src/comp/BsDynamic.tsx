import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useScrollDir from '../hooks/useScrollDir';

// DYNAMIC ACTION BUTTON COMPONENT ---
// Renders sticky or inline primary action buttons that respond to scroll direction and context
const BsDynamic = props => {
	const { nowAt, brain, menuView, superMan, text, className, isIntroduction, isChatSetup, setInitialize, disabled } = props;
	const navigate = useNavigate();
	const [bigButton, setBigButton] = useState(nowAt !== 'home' || isIntroduction);
	const [scrollDir] = useScrollDir(Boolean(isIntroduction));

	// INTERSECTION OBSERVER SETUP ---
	// Monitors header visibility to toggle between small and large button states
	useEffect(() => {
		if (isIntroduction || nowAt === 'setup' || isChatSetup) return;
		const observer = new IntersectionObserver(entries => entries.forEach(entry => setBigButton(entry.isIntersecting)));
		const elemToObserve = document.querySelector('header-image');
		if (elemToObserve) observer.observe(elemToObserve);
		return () => observer.disconnect();
	}, []);

	// PRIMARY BUTTON ACTION MAPPING ---
	// Defines behaviors for the main action button based on current route
	const bigBsFunctions = {
		setup: () => superMan('bigButton'),
		home: () => navigate('editor'),
	};

	// COMPONENT RENDERING ---
	// Renders the dynamic button container with transform-based scroll animations
	return (
		<dynamic-bs
			style={{
				'--translateY': scrollDir === 'up' || !['home', 'event'].includes(nowAt) || isIntroduction || menuView ? '0%' : `3rem`,
				transform: !isIntroduction ? 'translateX(-50%) translateY(var(--translateY))' : '',
				transition: 'transform 0.3s',
				width: '100%',
				zIndex: 2000,
			}}
			class={`${scrollDir === 'down' && !bigButton ? 'noPoint' : ''}   zinMaXl flexCen w100 ${!isIntroduction ? 'posFix botCen' : ''}`}>
			{/* SECONDARY NAVIGATION CONTROLS --- */}
			{/* Renders back and scroll-to-top buttons when header is not visible */}
			{!isIntroduction && !bigButton && scrollDir === 'up' && (
				<small-buttons className='posAbs  botCen marBotM posRel  w70 bw50 mw40 flexCen'>
					{nowAt !== 'home' ||
						(brain.homeView !== 'cityEvents' && (
							<button
								style={{ filter: 'hue-rotate(30deg) ' }}
								className='hr3 bBlue tWhite fs-1'
								onClick={() => {
									if (nowAt === 'chatSetup') window.history.back();
									else if (nowAt === 'home' && brain.homeView !== 'cityEvents') setInitialize('cityEvents');
									else !brain || brain.fastLoaded ? navigate('/') : window.history.back();
								}}>
								{nowAt === 'home' && brain.homeView !== 'cityEvents' ? 'Domů' : `zpět [esc.]`}
							</button>
						))}
					<button
						className='padVerXxxs marAuto bBlue tWhite  fs9'
						onClick={() => window.scrollTo({ top: nowAt !== 'home' ? 0 : document.querySelector('cats-wrapper').offsetTop + 220, behavior: 'smooth' })}>
						Nahoru
					</button>
				</small-buttons>
			)}
			{/* PRIMARY CONTEXTUAL ACTION BUTTON --- */}
			{/* Renders the large call-to-action button for home and setup screens */}
			{['home', 'setup'].includes(nowAt) && !menuView && (
				<big-button
					onClick={() => !disabled && bigBsFunctions[nowAt]()}
					className={`${className || 'bDarkGreen'} ${bigButton && !menuView ? 'fadedIn ' : 'noPoint'} ${disabled ? 'noPoint' : 'pointer'} w95 textAli flexCol justCen ${
						!isIntroduction ? 'marBotM bsContentGlow mw110 mh6  fs24' : 'mh6  fs20 mw80 bInsetGreen'
					}  zinMaXl marAuto tSha10  tWhite  padHorXs bInsetGreen borBot8 zinMenu  xBold posRel shaTop borderLight boRadXs  fadingIn  tWhite `}>
					{text}
				</big-button>
			)}
		</dynamic-bs>
	);
};

export default BsDynamic;
