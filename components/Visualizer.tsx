
import React, { useEffect, useRef } from 'react';
import { SessionState } from '../types';

interface VisualizerProps {
  state: SessionState;
  analyser?: AnalyserNode | null;
}

const Visualizer: React.FC<VisualizerProps> = ({ state, analyser }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !analyser) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    let time = 0;

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);
      time += 0.02;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      
      // Calculate average volume
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      const volumeScale = state === SessionState.LISTENING ? 0.4 + (average / 128) * 0.6 : 0.4;
      
      const baseRadius = 80 * volumeScale;

      // Draw glowing background
      const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, baseRadius * 2);
      glow.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
      glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(centerX, centerY, baseRadius * 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Draw the morphing orb
      ctx.beginPath();
      const points = 80;
      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2;
        
        // Simulating fluid morphing using sine waves and audio data
        const freqIndex = Math.floor((i / points) * (bufferLength / 4));
        const audioVal = (dataArray[freqIndex] / 255) * 40 * (state === SessionState.LISTENING ? 1 : 0);
        
        const offset = Math.sin(angle * 4 + time) * 10 + 
                       Math.cos(angle * 2 - time * 1.5) * 5 + 
                       audioVal;
        
        const r = baseRadius + offset;
        const x = centerX + Math.cos(angle) * r;
        const y = centerY + Math.sin(angle) * r;
        
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      
      ctx.closePath();
      ctx.fillStyle = 'white';
      ctx.fill();
      
      // Add a subtle stroke for depth
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [analyser, state]);

  return (
    <div className="relative flex items-center justify-center w-full h-80 transition-opacity duration-500">
      <canvas 
        ref={canvasRef} 
        width={500} 
        height={500} 
        className={`w-full max-w-[400px] h-full transition-transform duration-300 ${state === SessionState.PAUSED ? 'scale-75 opacity-50' : 'scale-100 opacity-100'}`}
      />
    </div>
  );
};

export default Visualizer;
