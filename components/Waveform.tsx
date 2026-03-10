import React, { useEffect, useRef } from 'react';

interface WaveformProps {
  isActive: boolean;
  color: string;
  amplitude?: number;
}

const Waveform: React.FC<WaveformProps> = ({ isActive, color, amplitude = 0 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let offset = 0;
    const draw = () => {
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      
      const midY = height / 2;
      
      if (isActive) {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        
        const segments = 50;
        const segmentWidth = width / segments;
        
        ctx.moveTo(0, midY);
        
        for (let i = 0; i <= segments; i++) {
          const x = i * segmentWidth;
          // Dynamically scale based on amplitude
          const variance = amplitude * 40;
          // Add some organic jitter/wave
          const y = midY + Math.sin(i * 0.4 + offset) * variance;
          ctx.lineTo(x, y);
        }
        
        ctx.stroke();
        
        // Add a secondary subtle glow wave
        ctx.beginPath();
        ctx.strokeStyle = color + '33'; // 20% opacity
        ctx.lineWidth = 6;
        ctx.moveTo(0, midY);
        for (let i = 0; i <= segments; i++) {
          const x = i * segmentWidth;
          const variance = amplitude * 50;
          const y = midY + Math.sin(i * 0.3 + offset * 0.8) * variance;
          ctx.lineTo(x, y);
        }
        ctx.stroke();

        offset += 0.15;
      } else {
        // Subtle resting line
        ctx.beginPath();
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      
      animationRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isActive, color, amplitude]);

  return (
    <canvas 
      ref={canvasRef} 
      width={400} 
      height={80} 
      className="w-full h-16 rounded-lg pointer-events-none"
    />
  );
};

export default Waveform;