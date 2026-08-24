import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { AppProvider } from './context/AppContext';
import AppLayout from './components/layout/AppLayout';
import ToastContainer from './components/Toast';
import Skeleton from './components/Skeleton';
import ConfirmDialog from './components/ConfirmDialog';

const Overview     = lazy(() => import('./pages/Overview'));
const Explorer     = lazy(() => import('./pages/Explorer'));
const Enrichment   = lazy(() => import('./pages/Enrichment'));
const DataHealth   = lazy(() => import('./pages/DataHealth'));
const MediaStorage = lazy(() => import('./pages/MediaStorage'));
const LiveLogs     = lazy(() => import('./pages/LiveLogs'));
const ScrapePage   = lazy(() => import('./pages/ScrapePage'));
const SourcesPage  = lazy(() => import('./pages/SourcesPage'));

function PageLoader() {
  return (
    <div className="container">
      <Skeleton height={80} count={3} style={{ marginBottom: 12 }} />
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppProvider>
        <AppLayout>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/overview"    element={<Overview />} />
              <Route path="/scrape"      element={<ScrapePage />} />
              <Route path="/explorer"    element={<Explorer />} />
              <Route path="/enrichment"  element={<Enrichment />} />
              <Route path="/data-health" element={<DataHealth />} />
              <Route path="/media"       element={<MediaStorage />} />
              <Route path="/logs"        element={<LiveLogs />} />
              <Route path="/sources"     element={<SourcesPage />} />
              <Route path="*"            element={<Navigate to="/overview" replace />} />
            </Routes>
          </Suspense>
          <ToastContainer />
          <ConfirmDialog />
        </AppLayout>
      </AppProvider>
    </HashRouter>
  );
}
