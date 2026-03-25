import ReactDOM from 'react-dom/client';
import { App } from './app';
import { AuthProvider } from './auth';
import './tailwind.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <AuthProvider>
    <App />
  </AuthProvider>,
);
