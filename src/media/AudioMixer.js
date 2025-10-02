/**
 * AudioMixer Class for combining multiple subscriber audio streams
 * Provides centralized audio mixing and playback management
 */
class AudioMixer {
  constructor(config = {}) {
    this.audioContext = null;
    this.mixerNode = null;
    this.outputDestination = null;
    this.subscriberNodes = new Map(); // subscriberId -> AudioWorkletNode
    this.isInitialized = false;
    this.outputAudioElement = null;

    // Configuration
    this.masterVolume = config.masterVolume || 0.8;
    this.sampleRate = config.sampleRate || 48000;
    this.bufferSize = config.bufferSize || 256;
    this.enableEchoCancellation = config.enableEchoCancellation !== false;
    this.debug = config.debug || false;
  }

  /**
   * Initialize the audio mixer
   */
  async initialize() {
    if (this.isInitialized) {
      this._debug("AudioMixer already initialized");
      return;
    }

    try {
      // Create shared AudioContext
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)({
        sampleRate: this.sampleRate,
        latencyHint: "interactive",
      });

      // Resume context if suspended (required by some browsers)
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      // Create mixer node (GainNode to combine audio)
      this.mixerNode = this.audioContext.createGain();
      this.mixerNode.gain.value = this.masterVolume;

      // Create output destination
      this.outputDestination = this.audioContext.createMediaStreamDestination();
      this.mixerNode.connect(this.outputDestination);

      // Create hidden audio element for mixed audio playback
      this.outputAudioElement = document.createElement("audio");
      this.outputAudioElement.autoplay = true;
      this.outputAudioElement.style.display = "none";
      this.outputAudioElement.setAttribute("playsinline", "");

      // Disable echo cancellation on output element
      if (this.enableEchoCancellation) {
        this.outputAudioElement.setAttribute("webkitAudioContext", "true");
      }

      document.body.appendChild(this.outputAudioElement);

      this.isInitialized = true;
      this._debug("AudioMixer initialized successfully");

      // Setup error handlers
      this._setupErrorHandlers();
    } catch (error) {
      console.error("Failed to initialize AudioMixer:", error);
      throw error;
    }
  }

  /**
   * Add a subscriber's audio stream to the mixer
   */
  async addSubscriber(
    subscriberId,
    audioWorkletUrl,
    isOwnAudio = false,
    channelWorkletPort
  ) {
    console.warn(`Adding subscriber ${subscriberId} to audio mixer`);
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Skip adding own audio to prevent echo/feedback
    if (isOwnAudio) {
      this._debug(
        `Skipping own audio for subscriber ${subscriberId} to prevent echo`
      );
      return null;
    }

    // Check if subscriber already exists
    if (this.subscriberNodes.has(subscriberId)) {
      this._debug(`Subscriber ${subscriberId} already exists in mixer`);
      return this.subscriberNodes.get(subscriberId);
    }

    try {
      // Load audio worklet if not already loaded
      await this._loadAudioWorklet(audioWorkletUrl);

      // Create AudioWorkletNode for this subscriber
      const workletNode = new AudioWorkletNode(
        this.audioContext,
        "jitter-resistant-processor",
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        }
      );

      // Connect the port if provided
      if (channelWorkletPort) {
        workletNode.port.postMessage(
          { type: "connectWorker", port: channelWorkletPort },
          [channelWorkletPort]
        );
      }

      // Create gain node for individual volume control
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 1.0;

      // Connect: workletNode -> gainNode -> mixerNode
      workletNode.connect(gainNode);
      gainNode.connect(this.mixerNode);

      // Store reference with gain node
      this.subscriberNodes.set(subscriberId, {
        workletNode,
        gainNode,
        isActive: true,
        addedAt: Date.now(),
      });

      // Update audio element source with mixed stream
      this._updateOutputAudio();

      // Setup message handler
      this._setupWorkletMessageHandler(subscriberId, workletNode);

      this._debug(`Added subscriber ${subscriberId} to audio mixer`);
      return workletNode;
    } catch (error) {
      console.error(
        `Failed to add subscriber ${subscriberId} to mixer:`,
        error
      );
      throw error;
    }
  }

  /**
   * Remove a subscriber from the mixer
   */
  removeSubscriber(subscriberId) {
    const subscriberData = this.subscriberNodes.get(subscriberId);
    if (!subscriberData) {
      this._debug(`Subscriber ${subscriberId} not found in mixer`);
      return false;
    }

    try {
      const { workletNode, gainNode } = subscriberData;

      // Disconnect nodes
      workletNode.disconnect();
      gainNode.disconnect();

      // Remove from map
      this.subscriberNodes.delete(subscriberId);

      // Update audio element if no more subscribers
      this._updateOutputAudio();

      this._debug(`Removed subscriber ${subscriberId} from audio mixer`);
      return true;
    } catch (error) {
      console.error(`Failed to remove subscriber ${subscriberId}:`, error);
      return false;
    }
  }

  /**
   * Set volume for a specific subscriber
   */
  setSubscriberVolume(subscriberId, volume) {
    const subscriberData = this.subscriberNodes.get(subscriberId);
    if (!subscriberData) {
      this._debug(`Subscriber ${subscriberId} not found for volume adjustment`);
      return false;
    }

    try {
      const normalizedVolume = Math.max(0, Math.min(1, volume));
      subscriberData.gainNode.gain.value = normalizedVolume;

      this._debug(
        `Set volume for subscriber ${subscriberId}: ${normalizedVolume}`
      );
      return true;
    } catch (error) {
      console.error(
        `Failed to set volume for subscriber ${subscriberId}:`,
        error
      );
      return false;
    }
  }

  /**
   * Mute/unmute a specific subscriber
   */
  setSubscriberMuted(subscriberId, muted) {
    return this.setSubscriberVolume(subscriberId, muted ? 0 : 1);
  }

  /**
   * Set master volume for all mixed audio
   */
  setMasterVolume(volume) {
    if (!this.mixerNode) return false;

    try {
      const normalizedVolume = Math.max(0, Math.min(1, volume));
      this.mixerNode.gain.value = normalizedVolume;
      this.masterVolume = normalizedVolume;

      this._debug(`Set master volume: ${normalizedVolume}`);
      return true;
    } catch (error) {
      console.error("Failed to set master volume:", error);
      return false;
    }
  }

  /**
   * Get mixed audio output stream
   */
  getOutputMediaStream() {
    if (!this.outputDestination) {
      this._debug("Output destination not initialized");
      return null;
    }
    return this.outputDestination.stream;
  }

  /**
   * Get current mixer statistics
   */
  getStats() {
    return {
      isInitialized: this.isInitialized,
      subscriberCount: this.subscriberNodes.size,
      masterVolume: this.masterVolume,
      audioContextState: this.audioContext?.state || "not-initialized",
      sampleRate: this.audioContext?.sampleRate || 0,
      subscribers: Array.from(this.subscriberNodes.entries()).map(
        ([id, data]) => ({
          id,
          volume: data.gainNode.gain.value,
          isActive: data.isActive,
          addedAt: data.addedAt,
        })
      ),
    };
  }

  /**
   * Get list of subscriber IDs
   */
  getSubscriberIds() {
    return Array.from(this.subscriberNodes.keys());
  }

  /**
   * Check if subscriber exists in mixer
   */
  hasSubscriber(subscriberId) {
    return this.subscriberNodes.has(subscriberId);
  }

  /**
   * Suspend audio context (for battery saving)
   */
  async suspend() {
    if (this.audioContext && this.audioContext.state === "running") {
      await this.audioContext.suspend();
      this._debug("Audio context suspended");
    }
  }

  /**
   * Resume audio context
   */
  async resume() {
    if (this.audioContext && this.audioContext.state === "suspended") {
      await this.audioContext.resume();
      this._debug("Audio context resumed");
    }
  }

  /**
   * Cleanup mixer resources
   */
  async cleanup() {
    this._debug("Starting AudioMixer cleanup");

    try {
      // Remove audio element
      if (this.outputAudioElement) {
        this.outputAudioElement.srcObject = null;
        if (this.outputAudioElement.parentNode) {
          this.outputAudioElement.parentNode.removeChild(
            this.outputAudioElement
          );
        }
        this.outputAudioElement = null;
      }

      // Disconnect all subscribers
      for (const [subscriberId, subscriberData] of this.subscriberNodes) {
        try {
          const { workletNode, gainNode } = subscriberData;
          workletNode.disconnect();
          gainNode.disconnect();
        } catch (error) {
          console.error(
            `Error disconnecting subscriber ${subscriberId}:`,
            error
          );
        }
      }
      this.subscriberNodes.clear();

      // Disconnect mixer components
      if (this.mixerNode) {
        this.mixerNode.disconnect();
        this.mixerNode = null;
      }

      if (this.outputDestination) {
        this.outputDestination = null;
      }

      // Close audio context
      if (this.audioContext && this.audioContext.state !== "closed") {
        await this.audioContext.close();
      }

      // Reset state
      this.audioContext = null;
      this.isInitialized = false;

      this._debug("AudioMixer cleanup completed");
    } catch (error) {
      console.error("Error during AudioMixer cleanup:", error);
    }
  }

  /**
   * Load audio worklet module
   */
  async _loadAudioWorklet(audioWorkletUrl) {
    console.warn("Loading audio worklet from:", audioWorkletUrl);
    try {
      await this.audioContext.audioWorklet.addModule(audioWorkletUrl);
      this._debug("Audio worklet loaded:", audioWorkletUrl);
    } catch (error) {
      // Worklet might already be loaded
      if (!error.message.includes("already been loaded")) {
        this._debug("Audio worklet load warning:", error.message);
      }
    }
  }

  /**
   * Update output audio element
   */
  _updateOutputAudio() {
    if (!this.outputAudioElement || !this.outputDestination) return;

    try {
      if (this.subscriberNodes.size > 0) {
        this.outputAudioElement.srcObject = this.outputDestination.stream;
      } else {
        this.outputAudioElement.srcObject = null;
      }
    } catch (error) {
      console.error("Failed to update output audio:", error);
    }
  }

  /**
   * Setup message handler for worklet node
   */
  _setupWorkletMessageHandler(subscriberId, workletNode) {
    workletNode.port.onmessage = (event) => {
      const { type, bufferMs, isPlaying, newBufferSize, error } = event.data;

      switch (type) {
        case "bufferStatus":
          this._debug(
            `Subscriber ${subscriberId} buffer: ${bufferMs}ms, playing: ${isPlaying}`
          );
          break;
        case "bufferSizeChanged":
          this._debug(
            `Subscriber ${subscriberId} buffer size changed: ${newBufferSize}`
          );
          break;
        case "error":
          console.error(`Subscriber ${subscriberId} worklet error:`, error);
          break;
        default:
          this._debug(
            `Subscriber ${subscriberId} worklet message:`,
            event.data
          );
      }
    };

    workletNode.port.onerror = (error) => {
      console.error(`Subscriber ${subscriberId} worklet port error:`, error);
    };
  }

  /**
   * Setup error handlers for audio context
   */
  _setupErrorHandlers() {
    if (!this.audioContext) return;

    this.audioContext.onstatechange = () => {
      this._debug(`Audio context state changed: ${this.audioContext.state}`);

      if (this.audioContext.state === "interrupted") {
        console.warn("Audio context was interrupted");
      }
    };

    // Listen for audio context suspend/resume events
    document.addEventListener("visibilitychange", async () => {
      if (document.hidden) {
        // Page hidden - optionally suspend context
        // await this.suspend();
      } else {
        // Page visible - resume context if needed
        await this.resume();
      }
    });
  }

  /**
   * Debug logging
   */
  _debug(...args) {
    if (this.debug) {
      console.log("[AudioMixer]", ...args);
    }
  }

  /**
   * Sleep utility for delays
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default AudioMixer;
