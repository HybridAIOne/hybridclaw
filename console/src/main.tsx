import ReactDOM from 'react-dom/client';
import { App } from './app';
import { AuthProvider } from './auth';
import { ToastProvider } from './components/toast';
import './theme.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <AuthProvider>
    <ToastProvider>
      <App />
    </ToastProvider>
  </AuthProvider>,
);
