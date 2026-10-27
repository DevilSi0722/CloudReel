import {useState, type ReactNode} from 'react';

export default function TitleArt({src, title, className = '', fallback}: {src?: string; title: string; className?: string; fallback?: ReactNode}) {
  const [failed, setFailed] = useState('');
  return src && failed !== src ? <img className={`title-art ${className}`} src={src} alt={title} draggable={false} onError={() => setFailed(src)} /> : <>{fallback}</>;
}
