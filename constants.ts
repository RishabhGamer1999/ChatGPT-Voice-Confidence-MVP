
export const MODEL_CONFIG = {
  metadata: {
    projectName: "ChatGPT Voice Confidence MVP",
    version: "1.1.0",
    description: "Hinglish voice interface inspired by ChatGPT Advanced Voice Mode"
  },
  uiConfig: {
    colors: {
      primary: "#ffffff",
      accent: "#10a37f", // ChatGPT Green
      orb: "#ffffff",
      bg: "#0d0d0d",
      privacyBg: "#171717",
      warning: "#ff9d00"
    },
    confidenceThreshold: 0.75
  },
  sampleTranscripts: [
    {
      id: "t1",
      type: "hinglish",
      spoken: "Mera plan kya hai aaj ka?",
      displayed: "Mera plan kya hai aaj ka?",
      translation: "What is my plan for today?",
      confidence: 0.98,
      timestamp: "10:00:01"
    },
    {
      id: "t2",
      type: "hinglish",
      spoken: "Context window ka logic samjhao",
      displayed: "Context window ka logic samjhao",
      translation: "Explain the logic of context windows",
      confidence: 0.88,
      timestamp: "10:00:05"
    }
  ]
};
