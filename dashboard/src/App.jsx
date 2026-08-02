import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import Header from './components/Header';
import TabNav from './components/TabNav';
import ToastContainer from './components/Toast';
import Skeleton from './components/Skeleton';

const Overview  = lazy(() => import('./pages/Overview'));
const Explorer  = lazy(() => import('./pages/Explorer'));
const GlobePage = lazy(() => import('./pages/GlobePage'));
const Enrichment = lazy(() => import('./pages/Enrichment'));
const DataHealth = lazy(() => import('./pages/DataHealth'));
const Simulations = lazy(() => import('./pages/SimulationsPage'));
const MediaStorage = lazy(() => import('./pages/MediaStorage'));

// Feature flag: set to true to enable Simulations/game page
const FEATURE_GAME = false;

function PageLoader() {
  return (
    <div className="container">
      <Skeleton height={80} count={3} style={{ marginBottom: 12 }} />
    </div>
  );
}

function AppShell() {
  const { chainsCache } = useApp();

  return (
    <>
      <Header />
      <TabNav badges={{ chainCount: chainsCache.length || 0 }} />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/overview" element={<Overview />} />
          <Route path="/explorer" element={<Explorer />} />
          <Route path="/globe"    element={<GlobePage />} />
          <Route path="/enrichment" element={<Enrichment />} />
          <Route path="/data-health" element={<DataHealth />} />
          <Route path="/media"       element={<MediaStorage />} />
          {FEATURE_GAME && <Route path="/simulations" element={<Simulations />} />}
          <Route path="*"         element={<Navigate to="/overview" replace />} />
        </Routes>
      </Suspense>
      <ToastContainer />
    </>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppProvider>
        <AppShell />
      </AppProvider>
    </HashRouter>
  );
}
