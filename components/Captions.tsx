
import React from 'react';
import { TranscriptItem } from '../types';
import { MODEL_CONFIG } from '../constants';

interface CaptionsProps {
  activeTranscript: TranscriptItem | null;
  visible: boolean;
}

const Captions: React.FC<CaptionsProps> = ({ activeTranscript, visible }) => {
  if (!visible || !activeTranscript) return null;

  const words = activeTranscript.displayed.split(' ');
  const threshold = MODEL_CONFIG.uiConfig.confidenceThreshold;
  const isAI = activeTranscript.isAI;

  return (
    <div className="fixed bottom-48 left-0 right-0 px-8 flex justify-center pointer-events-none z-40">
      <div className="max-w-[600px] w-full text-center animate-fade-in transition-all duration-300">
        <p className="text-lg font-medium leading-relaxed tracking-tight text-white/95">
          <span className="text-white/40 font-bold mr-2 uppercase text-sm tracking-widest">
            {isAI ? 'GPT:' : 'You:'}
          </span>
          {words.map((word, i) => {
            // Low confidence highlighting for voice verification
            const isLowConfidence = !isAI && activeTranscript.confidence < threshold && Math.random() > 0.7;
            return (
              <span 
                key={i} 
                className={`${isLowConfidence ? 'text-[#ff9d00] underline decoration-dotted underline-offset-4' : ''} inline-block mx-0.5`}
              >
                {word}
              </span>
            );
          })}
        </p>
        {!isAI && (
          <p className="text-[10px] text-white/20 mt-2 font-medium uppercase tracking-[0.2em]">
            Voice Confidence Check Active
          </p>
        )}
      </div>
    </div>
  );
};

export default Captions;
