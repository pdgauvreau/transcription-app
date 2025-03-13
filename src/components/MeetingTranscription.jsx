import React, { useState, useEffect, useRef } from "react";

const MeetingTranscription = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState([]);
  const [currentSpeakerId, setCurrentSpeakerId] = useState(1);
  const [error, setError] = useState("");
  
  const micStreamRef = useRef(null);
  const socketRef = useRef(null);
  const recognitionRef = useRef(null);
  const speakerFeaturesRef = useRef({});
  const lastSpeakerRef = useRef(null);
  const silenceTimeoutRef = useRef(null);
  
  // Replace with your Google Cloud API key and configuration
  const GOOGLE_API_KEY = "fair-canto-453417-i3";
  
  // Start streaming audio to Google Cloud Speech-to-Text API
  const startStreaming = async (stream) => {
    try {
      // Stop any existing stream
      if (socketRef.current) {
        stopRecording();
      }
      
      // Store the stream
      micStreamRef.current = stream;
      
      // Create audio context for processing
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      
      // Create analyser for speaker detection
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      
      // Create processor node for speaker detection
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      analyser.connect(processor);
      processor.connect(audioContext.destination);
      
      // Process audio for speaker detection
      processor.onaudioprocess = (e) => {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        processAudioFeatures(data);
      };
      
      // Set up WebSocket connection to Google Cloud Speech-to-Text
      const socketUrl = `wss://speech.googleapis.com/v1/speech:streamingRecognize?key=${GOOGLE_API_KEY}`;
      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;
      
      // Handle WebSocket events
      socket.onopen = () => {
        console.log("WebSocket connection established");
        
        // Send configuration
        const configMessage = {
          streamingConfig: {
            config: {
              encoding: "LINEAR16",
              sampleRateHertz: 16000,
              languageCode: "en-US",
              enableAutomaticPunctuation: true,
              enableSpeakerDiarization: true,
              diarizationSpeakerCount: 2,
              model: "default"
            },
            interimResults: true
          }
        };
        
        socket.send(JSON.stringify(configMessage));
        
        // Set up audio processing for streaming
        const recorder = new MediaRecorder(stream);
        recognitionRef.current = recorder;
        
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0 && socket.readyState === 1) {
            // Convert blob to arrayBuffer
            event.data.arrayBuffer().then(buffer => {
              // Convert to base64
              const base64Data = btoa(
                String.fromCharCode.apply(null, new Uint8Array(buffer))
              );
              
              // Send audio data
              const audioMessage = {
                audioContent: base64Data
              };
              
              socket.send(JSON.stringify(audioMessage));
            });
          }
        };
        
        // Start recording in chunks
        recorder.start(100);
      };
      
      socket.onmessage = (event) => {
        const response = JSON.parse(event.data);
        
        // Process streaming recognition results
        if (response.results && response.results.length > 0) {
          const result = response.results[0];
          
          if (result.alternatives && result.alternatives.length > 0) {
            const text = result.alternatives[0].transcript;
            
            // Only process if we have text
            if (text && text.trim() !== "") {
              // Detect speaker changes and update transcript
              if (result.isFinal) {
                detectSpeakerChange(text.trim());
              }
            }
          }
        }
      };
      
      socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        setError("Error with speech recognition: " + error.message);
      };
      
      socket.onclose = () => {
        console.log("WebSocket connection closed");
        if (isRecording) {
          // Try to reconnect if this wasn't intentional
          setTimeout(() => {
            if (isRecording && micStreamRef.current) {
              startStreaming(micStreamRef.current);
            }
          }, 1000);
        }
      };
      
      setIsRecording(true);
      
    } catch (err) {
      setError("Error starting streaming: " + err.message);
    }
  };
  
  // Process audio features for speaker identification
  const processAudioFeatures = (dataArray) => {
    if (!dataArray || dataArray.length === 0) return;
    
    // Extract audio features
    const features = extractAudioFeatures(dataArray);
    
    // Store the current audio features
    lastSpeakerRef.current = {
      ...lastSpeakerRef.current,
      features: features
    };
  };
  
  // Extract audio features for speaker identification
  const extractAudioFeatures = (dataArray) => {
    let sum = 0;
    let energy = 0;
    let lowFreqEnergy = 0;
    let highFreqEnergy = 0;
    
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
      energy += dataArray[i] * dataArray[i];
      
      // Split frequency bands
      if (i < dataArray.length / 2) {
        lowFreqEnergy += dataArray[i] * dataArray[i];
      } else {
        highFreqEnergy += dataArray[i] * dataArray[i];
      }
    }
    
    return {
      averageFrequency: sum / dataArray.length,
      energy: energy / dataArray.length,
      lowFreqEnergy: lowFreqEnergy / (dataArray.length / 2),
      highFreqEnergy: highFreqEnergy / (dataArray.length / 2),
      ratio: lowFreqEnergy / (highFreqEnergy || 1) // Avoid division by zero
    };
  };
  
  // Detect speaker changes based on audio features
  const detectSpeakerChange = (text) => {
    // Clear any pending silence detection
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
    }
    
    const currentFeatures = lastSpeakerRef.current?.features;
    
    // Determine if this is a new speaker
    const isSpeakerChange = shouldChangeSpeaker(currentFeatures);
    let speakerId = lastSpeakerRef.current?.id || 1;
    
    if (isSpeakerChange) {
      // Try to identify the speaker or create a new one
      speakerId = identifySpeaker(currentFeatures) || currentSpeakerId;
      
      // Add a new transcript entry
      setTranscript(prev => [...prev, { id: speakerId, text }]);
      
      // Update last speaker
      lastSpeakerRef.current = {
        ...lastSpeakerRef.current,
        id: speakerId
      };
      
      // If this is a new speaker, update the counter
      if (speakerId === currentSpeakerId) {
        // Store this speaker's features
        speakerFeaturesRef.current[speakerId] = currentFeatures;
        setCurrentSpeakerId(prev => prev + 1);
      }
    } else {
      // Continue with the same speaker
      setTranscript(prev => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1].text += " " + text;
        } else {
          updated.push({ id: speakerId, text });
        }
        return updated;
      });
    }
    
    // Set silence detection timeout
    silenceTimeoutRef.current = setTimeout(() => {
      lastSpeakerRef.current = {
        ...lastSpeakerRef.current,
        id: null
      };
    }, 1500);
  };
  
  // Determine if we should change the speaker
  const shouldChangeSpeaker = (features) => {
    if (!lastSpeakerRef.current?.id) return true;
    if (!features) return false;
    
    const lastFeatures = lastSpeakerRef.current.features;
    if (!lastFeatures) return true;
    
    // Compare audio features
    const freqDiff = Math.abs(features.averageFrequency - lastFeatures.averageFrequency);
    const energyDiff = Math.abs(features.energy - lastFeatures.energy);
    const ratioDiff = Math.abs(features.ratio - lastFeatures.ratio);
    
    // Thresholds for speaker change detection
    return (freqDiff > 20) || (energyDiff > 1000) || (ratioDiff > 0.4);
  };
  
  // Try to identify if a speaker has been heard before
  const identifySpeaker = (features) => {
    if (!features) return null;
    
    let bestMatchId = null;
    let bestMatchScore = 0;
    
    // Compare with known speakers
    Object.entries(speakerFeaturesRef.current).forEach(([id, storedFeatures]) => {
      const freqDiff = Math.abs(features.averageFrequency - storedFeatures.averageFrequency);
      const energyDiff = Math.abs(features.energy - storedFeatures.energy);
      const ratioDiff = Math.abs(features.ratio - storedFeatures.ratio);
      
      // Calculate similarity score
      const similarityScore = 
        (freqDiff < 15 ? 1 : 0) + 
        (energyDiff < 800 ? 1 : 0) + 
        (ratioDiff < 0.3 ? 1 : 0);
      
      if (similarityScore > bestMatchScore) {
        bestMatchScore = similarityScore;
        bestMatchId = parseInt(id);
      }
    });
    
    // Need at least 2 matching features to identify a speaker
    return bestMatchScore >= 2 ? bestMatchId : null;
  };
  
  // Start recording with microphone
  const startRecording = async () => {
    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        },
        video: false
      });
      
      // Initialize transcript
      setTranscript([]);
      setCurrentSpeakerId(1);
      speakerFeaturesRef.current = {};
      lastSpeakerRef.current = null;
      
      // Start streaming to Google Cloud Speech API
      startStreaming(stream);
      
    } catch (err) {
      setError("Error accessing microphone: " + err.message);
    }
  };
  
  // Capture system audio
  const captureSystemAudio = async () => {
    try {
      // Request display capture with audio
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      
      // Check if we have audio
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error("No audio track found. Make sure to select 'Share audio' when prompted.");
      }
      
      // Create a new stream with just the audio
      const audioStream = new MediaStream([audioTracks[0]]);
      
      // Initialize transcript
      setTranscript([]);
      setCurrentSpeakerId(1);
      speakerFeaturesRef.current = {};
      lastSpeakerRef.current = null;
      
      // Start streaming
      startStreaming(audioStream);
      
    } catch (err) {
      setError("Error capturing system audio: " + err.message);
    }
  };
  
  // Stop recording
  const stopRecording = () => {
    // Close WebSocket connection
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    
    // Stop MediaRecorder
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    
    // Stop all tracks in the stream
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
    
    // Clear silence detection timeout
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }
    
    setIsRecording(false);
  };
  
  // Toggle recording state
  const handleToggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };
  
  // Export transcript to file
  const exportTranscript = () => {
    if (transcript.length === 0) return;
    
    let content = "";
    transcript.forEach(entry => {
      content += `Speaker ${entry.id}: ${entry.text}\n\n`;
    });
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'meeting-transcript.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);
  
  return (
    <div className="flex flex-col p-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Meeting Transcription</h1>
      
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}
      
      <div className="flex gap-4 mb-4">
        <button
          onClick={handleToggleRecording}
          className={`px-4 py-2 rounded font-bold ${
            isRecording ? "bg-red-500 text-white" : "bg-blue-500 text-white"
          }`}
        >
          {isRecording ? "Stop Recording" : "Start Recording (Microphone)"}
        </button>
        
        <button
          onClick={captureSystemAudio}
          className="px-4 py-2 rounded font-bold bg-green-500 text-white"
          disabled={isRecording}
        >
          Capture Meeting Audio
        </button>
        
        <button
          onClick={exportTranscript}
          className="px-4 py-2 rounded font-bold bg-purple-500 text-white"
          disabled={transcript.length === 0}
        >
          Export Transcript
        </button>
      </div>
      
      <div className="border rounded p-4 bg-gray-50 min-h-64 max-h-96 overflow-y-auto">
        {transcript.length === 0 ? (
          <p className="text-gray-500">Transcription will appear here...</p>
        ) : (
          <div className="space-y-4">
            {transcript.map((entry, index) => (
              <div key={index} className="mb-2">
                <span className="font-bold text-blue-600">Speaker {entry.id}: </span>
                <span>{entry.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      
      <div className="mt-4 text-sm text-gray-600">
        <p>
          Note: For system audio capture, you may need a virtual audio cable to
          route system audio to the browser.
        </p>
        <p>
          Make sure to set up Google Cloud Speech-to-Text API and replace the API
          key before using this component.
        </p>
      </div>
    </div>
  );
};

export default MeetingTranscription;