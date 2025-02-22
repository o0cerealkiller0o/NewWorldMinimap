import clsx from 'clsx';
import React, { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CSSObject, keyframes } from 'tss-react';
import RecenterIcon from '@/Icons/RecenterIcon';
import { drawMapHoverLabel } from '@/Minimap/drawMapLabels';
import MinimapToolbar from '@/MinimapToolbar';
import { AppContext } from './contexts/AppContext';
import { globalLayers } from './globalLayers';
import ZoomInIcon from './Icons/ZoomInIcon';
import ZoomOutIcon from './Icons/ZoomOutIcon';
import { FriendData, updateFriendLocation } from './logic/friends';
import { positionUpdateRate, registerEventCallback } from './logic/hooks';
import { getHotkeyManager } from './logic/hotkeyManager';
import { getMarkers } from './logic/markers';
import { getNavTarget, resetNav, setNav } from './logic/navigation/navigation';
import { store } from './logic/storage';
import { getTileCache } from './logic/tileCache';
import { canvasToMinimapCoordinate } from './logic/tiles';
import { getNearestTown } from './logic/townLocations';
import { rotateAround, squaredDistance } from './logic/util';
import { townZoomDistance } from './Minimap/mapConstants';
import useMinimapRenderer from './Minimap/useMinimapRenderer';
import MinimapToolbarIconButton from './MinimapToolbarIconButton';
import { makeStyles } from './theme';

interface IProps {
    className?: string;
}

const showRecenterButton = keyframes({
    from: {
        width: 0,
        padding: 0,
    },
    to: {
        width: 40,
        padding: 5,
    },
});

const useStyles = makeStyles()(theme => {
    const canvasStyling: CSSObject = {
        width: '100%',
        height: '100%',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    };
    return {
        minimap: {
            position: 'relative',
        },
        cacheStatus: {
            background: 'rgba(0, 0, 0, 0.5)',
            color: '#ffffff',
            position: 'absolute',
            left: 0,
            bottom: 0,
            zIndex: globalLayers.minimapCacheStatus,
        },
        canvas: {
            ...canvasStyling,
            zIndex: globalLayers.minimapCanvas,
        },
        hoverCanvas: {
            ...canvasStyling,
            zIndex: globalLayers.minimapHoverCanvas,
            pointerEvents: 'none',
        },
        mapControls: {
            position: 'absolute',
            right: theme.spacing(1),
            bottom: theme.spacing(1),
            display: 'flex',
            flexDirection: 'row-reverse',
        },
        recenter: {
            animation: `300ms ease ${showRecenterButton}`,
            display: 'flex',
            alignItems: 'center',
            '& > svg': {
                width: '100%',
            },
        },
    };
});

const tileCache = getTileCache();

const hotkeyManager = getHotkeyManager();
export default function Minimap(props: IProps) {
    const {
        className,
    } = props;
    const { classes } = useStyles();
    const { t } = useTranslation();

    const appContext = useContext(AppContext);

    const playerName = useRef<string>('UnknownFriend');

    const [tilesDownloading, setTilesDownloading] = useState(0);
    const [isMapDragged, setIsMapDragged] = useState(false);
    const canvas = useRef<HTMLCanvasElement>(null);
    const hoverLabelCanvas = useRef<HTMLCanvasElement>(null);

    const scrollingMap = useRef<{ pointerId: number, position: Vector2, threshold: boolean }>();

    const interpolationEnabled = appContext.settings.animationInterpolation !== 'none';

    const dynamicStyling: React.CSSProperties = {};

    if (appContext.isTransparentSurface) {
        dynamicStyling.clipPath = appContext.settings.shape;
    }

    const {
        currentFriends,
        currentPlayerPosition,
        currentPlayerAngle,
        lastDrawParameters,
        getZoomLevel,
        mapPositionOverride,
        redraw,
        setPlayerPosition,
        zoomBy,
    } = useMinimapRenderer(canvas, hoverLabelCanvas);

    function setPosition(pos: Vector2) {
        if (appContext.settings.shareLocation) {
            const sharedLocation = updateFriendLocation(appContext.settings.friendServerUrl, playerName.current, pos);
            sharedLocation.then(setFriends);
        }

        store('lastKnownPosition', pos);
        setPlayerPosition(pos);
    }

    function setFriends(channels: undefined | FriendData[]) {
        currentFriends.current = channels ?? [];
        redraw(true);
    }

    function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
        zoomBy(getZoomLevel() / 5 * e.deltaY / 100);
    }

    function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
        if (e.pointerType === 'mouse' && e.button === 1) {
            if (!canvas.current) { return; }
            const canvasPos = { x: e.clientX, y: e.clientY };
            const centerPos = mapPositionOverride.current ?? currentPlayerPosition.current;
            const width = canvas.current.width;
            const height = canvas.current.height;

            const town = getNearestTown(centerPos);
            const zoomLevel = town.distance <= townZoomDistance ? appContext.settings.townZoomLevel : appContext.settings.zoomLevel;

            let worldPos = canvasToMinimapCoordinate(canvasPos, centerPos, zoomLevel, width, height);
            if (appContext.settings.compassMode && (appContext.isTransparentSurface ?? false)) {
                worldPos = rotateAround(centerPos, worldPos, -currentPlayerAngle.current);
            }
            const currentTarget = getNavTarget();

            if (currentTarget && squaredDistance(worldPos, currentTarget) < 200) {
                resetNav();
            } else {
                setNav(currentPlayerPosition.current, worldPos);
            }

            redraw(true);
        }

        if (NWMM_APP_WINDOW !== 'desktop') {
            return;
        }
        // Left mouse button only
        if (e.pointerType === 'mouse' && e.button === 0) {
            scrollingMap.current = {
                pointerId: e.pointerId,
                position: { x: e.pageX, y: e.pageY },
                threshold: false,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
        }
    }

    function onRecenterMap() {
        mapPositionOverride.current = undefined;
        redraw(true);
        setIsMapDragged(false);
    }

    function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
        if (!hoverLabelCanvas) {
            return;
        }

        if (hoverLabelCanvas && lastDrawParameters.current && !appContext.settings.showText) {
            const mousePos = { x: e.pageX, y: e.pageY };
            drawMapHoverLabel(mousePos, lastDrawParameters.current, hoverLabelCanvas, appContext.settings.iconScale);
        }

        if (scrollingMap.current && scrollingMap.current.pointerId === e.pointerId) {
            const dX = e.pageX - scrollingMap.current.position.x;
            const dY = e.pageY - scrollingMap.current.position.y;
            const dragAllowed = scrollingMap.current.threshold || Math.abs(dX) > 3 || Math.abs(dY) > 3;
            if (dragAllowed) {
                if (!scrollingMap.current.threshold) {
                    scrollingMap.current.threshold = true;
                    mapPositionOverride.current = { ...mapPositionOverride.current ?? currentPlayerPosition.current };
                    setIsMapDragged(true);
                } else if (mapPositionOverride.current) {
                    mapPositionOverride.current.x -= dX * getZoomLevel() / 4;
                    mapPositionOverride.current.y += dY * getZoomLevel() / 4;
                }
                redraw(true);
                scrollingMap.current.position.x = e.pageX;
                scrollingMap.current.position.y = e.pageY;
            }
        }
    }

    function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
        if (scrollingMap.current && scrollingMap.current.pointerId === e.pointerId) {
            e.currentTarget.releasePointerCapture(e.pointerId);
            scrollingMap.current = undefined;
        }
    }

    useEffect(() => tileCache.registerOnTileDownloadingCountChange(setTilesDownloading, window), []);

    if (NWMM_APP_WINDOW === 'inGame') {
        // This is alright, because the app window descriptor does not change.
        // eslint-disable-next-line react-hooks/rules-of-hooks
        useEffect(() => {
            const zoomInRegistration = hotkeyManager.registerHotkey('zoomIn', () => zoomBy(getZoomLevel() / 5), window);
            const zoomOutRegistration = hotkeyManager.registerHotkey('zoomOut', () => zoomBy(getZoomLevel() / -5), window);
            return () => {
                zoomInRegistration();
                zoomOutRegistration();
            };
        }, [getZoomLevel()]);
    }

    // This effect starts a timer if interpolation is enabled.
    useEffect(() => {
        let allowed = true;
        const minFrameTime = positionUpdateRate / appContext.settings.resamplingRate;
        let lastTimestamp = performance.now();

        function animationFrame(time: DOMHighResTimeStamp) {
            if (time - lastTimestamp >= minFrameTime) {
                lastTimestamp = time;
                redraw(false);
            }
            start();
        }

        function start() {
            if (allowed) {
                requestAnimationFrame(animationFrame);
            }
        }

        start();

        return function () {
            allowed = false;
        };
    }, [interpolationEnabled, appContext.settings.resamplingRate]);

    // This effect adds an event handler for the window resize event, triggering a redraw when it fires.
    useEffect(() => {
        const onResize = () => redraw(true);
        window.addEventListener('resize', onResize);

        return function () {
            window.removeEventListener('resize', onResize);
        };
    }, []);

    // This effect adds a registration for position updates.
    useEffect(() => {
        // Expose the setPosition and getMarkers window on the global Window object
        (window as any).setPosition = setPosition;
        (window as any).getMarkers = getMarkers;
        (window as any).setFriends = setFriends;

        const callbackUnregister = registerEventCallback(info => {
            setPosition(info.position);

            if (info.name) {
                playerName.current = info.name;
            }
        }, window);

        return function () {
            callbackUnregister();
        };
    }, [appContext.settings]);

    return <div className={clsx(classes.minimap, className)}>
        <canvas
            ref={canvas}
            className={clsx(classes.canvas)}
            style={dynamicStyling}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerMove={handlePointerMove}
        />
        <canvas
            ref={hoverLabelCanvas}
            className={clsx(classes.hoverCanvas)}
            style={dynamicStyling}
        />
        <div className={classes.cacheStatus}>
            {tilesDownloading > 0 && <p>{t('minimap.tilesLoading', { count: tilesDownloading })}</p>}
        </div>
        {NWMM_APP_WINDOW === 'desktop' && <MinimapToolbar className={classes.mapControls}>
            <MinimapToolbarIconButton onClick={() => zoomBy(getZoomLevel() / -5)} title={t('minimap.zoomIn')}>
                <ZoomInIcon />
            </MinimapToolbarIconButton>
            <MinimapToolbarIconButton onClick={() => zoomBy(getZoomLevel() / 5)} title={t('minimap.zoomOut')}>
                <ZoomOutIcon />
            </MinimapToolbarIconButton>
            {isMapDragged && <MinimapToolbarIconButton className={classes.recenter} onClick={onRecenterMap} title={t('minimap.recenter')}>
                <RecenterIcon />
            </MinimapToolbarIconButton>}
        </MinimapToolbar>}
    </div>;
}
