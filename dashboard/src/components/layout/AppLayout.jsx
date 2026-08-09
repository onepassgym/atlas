import TopBar from './TopBar';
import Sidebar from './Sidebar';

export default function AppLayout({ children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000', overflow: 'hidden' }}>
      <TopBar />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar />
        <main style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          background: '#000',
        }}>
          {children}
        </main>
      </div>
    </div>
  );
}
