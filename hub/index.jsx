import React from 'react';
import { createRoot } from 'react-dom/client';
import WarRoom from './WarRoom.tsx';

const container = document.getElementById('root') || document.getElementById('app');
if (container) {
  const root = createRoot(container);
  root.render(<WarRoom />);
}
