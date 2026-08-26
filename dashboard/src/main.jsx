import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import App from './App.jsx';

// Apply the persisted theme before first paint to avoid a flash.
const savedTheme = localStorage.getItem('mc-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
