import EventEmitter from "../events/EventEmitter.js";

/**
 * WebRTC Publisher Class
 * Handles video/audio streaming via WebTransport
 */
export default class Publisher extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Validate required options
    if (!options.publishUrl) {
      throw new Error("publishUrl is required");
    }

    // Configuration
    this.publishUrl = options.publishUrl;
    this.streamType = options.streamType || "camera"; // 'camera' or 'display'
    this.streamId = options.streamId || "test_stream";

    // Video configuration
    this.currentConfig = {
      codec: "avc1.640c34",
      width: options.width || 1280,
      height: options.height || 720,
      framerate: options.framerate || 30,
      bitrate: options.bitrate || 1_500_000,
    };

    // Audio configuration
    this.kSampleRate = 48000;
    this.opusBaseTime = 0;
    this.opusSamplesSent = 0;
    this.opusSamplesPerChunk = 960; // 20ms at 48kHz
    this.opusChunkCount = 0;

    // State variables
    this.stream = null;
    this.audioProcessor = null;
    this.videoProcessor = null;
    this.webTransport = null;
    this.isChannelOpen = false;
    this.sequenceNumber = 0;
    this.isPublishing = false;

    this.cameraEnabled = true;
    this.micEnabled = true;
    this.hasCamera = options.hasCamera !== undefined ? options.hasCamera : true;
    this.hasMic = options.hasMic !== undefined ? options.hasMic : true;

    // Callbacks
    this.onStatusUpdate =
      options.onStatusUpdate || ((message, isError) => console.log(message));
    this.onStreamStart = options.onStreamStart || (() => {});
    this.onStreamStop = options.onStreamStop || (() => {});
    this.onServerEvent = options.onServerEvent || ((event) => {});

    // Initialize modules
    this.wasmInitialized = false;
    this.wasmInitializing = false;
    this.wasmInitPromise = null;
    this.initAudioRecorder = null;
    this.WasmEncoder = null;

    // Stream management
    this.publishStreams = new Map(); // key: channelName, value: {writer, reader, configSent, config}
    this.videoEncoders = new Map();
    this.eventStream = null; // Dedicated event stream

    this.subStreams = [
      {
        name: "high",
        width: 1280,
        height: 720,
        bitrate: 800_000,
        framerate: 30,
        channelName: "cam_720p",
      },
      // {
      //   name: "low",
      //   width: 854,
      //   height: 480,
      //   bitrate: 500_000,
      //   framerate: 30,
      //   channelName: "cam_360p",
      // },
      {
        name: "low",
        width: 640,
        height: 360,
        bitrate: 400_000,
        framerate: 30,
        channelName: "cam_360p",
      },
      {
        name: "screen",
        width: 1920,
        height: 1080,
        bitrate: 2_000_000,
        framerate: 30,
        channelName: "screen_share_1080p",
      },
      {
        name: "microphone",
        channelName: "mic_48k",
      },
    ];
  }

  async init() {
    await this.loadAllDependencies();
    this.onStatusUpdate("Publisher initialized successfully");
  }

  async loadAllDependencies() {
    try {
      if (
        !document.querySelector('script[src*="MSTP_polyfill.js"]')
      ) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "../polyfills/MSTP_polyfill.js";
          script.onload = () => resolve();
          script.onerror = () =>
            reject(new Error("Failed to load MSTP polyfill"));
          document.head.appendChild(script);
        });
        console.log("Polyfill loaded successfully");
      }

      if (!this.wasmInitialized) {
        if (this.wasmInitializing && this.wasmInitPromise) {
          await this.wasmInitPromise;
        } else {
          this.wasmInitializing = true;
          const { default: init, WasmEncoder } = await import(
            "../raptorQ/raptorq_wasm.js"
          );

          this.WasmEncoder = WasmEncoder;

          this.wasmInitPromise = init("../raptorQ/raptorq_wasm_bg.wasm")
            .then(() => {
              this.wasmInitialized = true;
              this.wasmInitializing = false;
              console.log("WASM encoder module loaded successfully");
            })
            .catch((err) => {
              this.wasmInitializing = false;
              console.error("Failed to load WASM encoder module:", err);
              throw new Error("Failed to load WASM encoder module");
            });

          await this.wasmInitPromise;
        }
      }

      const opusModule = await import(
        `/opus_decoder/opusDecoder.js?t=${Date.now()}`
      );
      this.initAudioRecorder = opusModule.initAudioRecorder;
      console.log("Opus decoder module loaded successfully");

      this.onStatusUpdate("All dependencies loaded successfully");
    } catch (error) {
      this.onStatusUpdate(`Dependency loading error: ${error.message}`, true);
      throw error;
    }
  }

  async startPublishing() {
    if (this.isPublishing) {
      this.onStatusUpdate("Already publishing", true);
      return;
    }
    await this.init();

    // Setup WebTransport connection
    await this.setupConnection();

    try {
      // Get media stream based on type
      await this.getMediaStream();
      this.isPublishing = true;
      // Start streaming
      await this.startStreaming();

      this.onStreamStart();
      this.onStatusUpdate("Publishing started successfully");
    } catch (error) {
      this.onStatusUpdate(`Failed to start publishing: ${error.message}`, true);
      throw error;
    }
  }

  // Toggle camera
  toggleCamera() {
    if (this.cameraEnabled) {
      this.turnOffCamera();
    } else {
      this.turnOnCamera();
    }
  }

  // Toggle mic
  toggleMic() {
    if (this.micEnabled) {
      this.turnOffMic();
    } else {
      this.turnOnMic();
    }
  }

  // Turn off camera (stop encoding video frames)
  turnOffCamera() {
    this.cameraEnabled = false;
    this.onStatusUpdate("Camera turned off");
  }

  // Turn on camera (resume encoding video frames)
  turnOnCamera() {
    this.cameraEnabled = true;
    // if (
    //   this.stream &&
    //   this.stream.getVideoTracks().length > 0 &&
    //   this.videoElement
    // ) {
    //   const videoOnlyStream = new MediaStream();
    //   videoOnlyStream.addTrack(this.stream.getVideoTracks()[0]);
    //   this.videoElement.srcObject = videoOnlyStream;
    // }
    this.onStatusUpdate("Camera turned on");
  }

  // Turn off mic (stop encoding audio chunks)
  turnOffMic() {
    this.micEnabled = false;
    this.onStatusUpdate("Mic turned off");
  }

  // Turn on mic (resume encoding audio chunks)
  turnOnMic() {
    this.micEnabled = true;
    this.onStatusUpdate("Mic turned on");
  }

  async getMediaStream() {
    if (this.streamType === "camera") {
      const constraints = {
        audio: {
          sampleRate: this.kSampleRate,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: {
          width: { ideal: this.currentConfig.width },
          height: { ideal: this.currentConfig.height },
          frameRate: { ideal: this.currentConfig.framerate },
        },
      };
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        console.error("Error accessing media devices:", error);
      }
    } else if (this.streamType === "display") {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      // Handle user stopping screen share via browser UI
      const videoTrack = this.stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          this.stop();
        };
      }
    }

    // Create video-only stream for display
    const videoOnlyStream = new MediaStream();
    const videoTracks = this.stream.getVideoTracks();

    if (videoTracks.length > 0) {
      videoOnlyStream.addTrack(videoTracks[0]);
    }

    // Emit local stream ready event for app integration
    this.emit("localStreamReady", {
      stream: this.stream,           // Full stream with audio + video
      videoOnlyStream: videoOnlyStream, // Video only stream
      streamType: this.streamType,
      streamId: this.streamId,
      config: this.currentConfig
    });
    this.onStatusUpdate(`${this.streamType} stream ready`);
  }

  initVideoEncoders() {
    this.subStreams.forEach((subStream) => {
      if (!subStream.channelName.startsWith("mic")) {
        console.log(`Setting up encoder for ${subStream.name}`);
        const encoder = new VideoEncoder({
          output: (chunk, metadata) =>
            this.handleVideoChunk(
              chunk,
              metadata,
              subStream.name,
              subStream.channelName
            ),
          error: (e) =>
            this.onStatusUpdate(
              `Encoder ${subStream.name} error: ${e.message}`,
              true
            ),
        });

        this.videoEncoders.set(subStream.name, {
          encoder,
          channelName: subStream.channelName,
          config: {
            codec: this.currentConfig.codec,
            width: subStream.width,
            height: subStream.height,
            bitrate: subStream.bitrate,
            framerate: this.currentConfig.framerate,
            latencyMode: "realtime",
            hardwareAcceleration: "prefer-hardware",
          },
          metadataReady: false,
          videoDecoderConfig: null,
        });
      }
    });
  }

  async setupConnection() {
    this.webTransport = new WebTransport(this.publishUrl);
    await this.webTransport.ready;
    console.log("WebTransport connected to server");

    await this.createEventStream();

    for (const subStream of this.subStreams) {
      if (!subStream.channelName.startsWith("screen")) {
        await this.createBidirectionalStream(subStream.channelName);
      }
    }

    this.isChannelOpen = true;
    this.onStatusUpdate(
      "WebTransport connection established with event stream and media streams"
    );
  }

  async createEventStream() {
    const stream = await this.webTransport.createBidirectionalStream();
    const readable = stream.readable;
    const writable = stream.writable;

    const writer = writable.getWriter();
    const reader = readable.getReader();

    this.eventStream = { writer, reader };

    console.log("WebTransport event stream established");

    const initData = new TextEncoder().encode("meeting_control");
    await this.sendOverEventStream(initData);

    // Setup reader cho event stream
    this.setupEventStreamReader(reader);

    await this.sendPublisherState();

    const workerInterval = new Worker("polyfills/intervalWorker.js");
    workerInterval.postMessage({ interval: 1000 });
    let lastPingTime = Date.now();

    workerInterval.onmessage = (e) => {
      const ping = new TextEncoder().encode("ping");
      this.sendOverEventStream(ping);
      if (Date.now() - lastPingTime > 1200) {
        console.warn("Ping delay detected, connection may be unstable");
      }
      lastPingTime = Date.now();
    };

    // setInterval(() => {
    //   const ping = new TextEncoder().encode("ping");
    //   this.sendOverEventStream(ping);
    //   console.log("Ping sent to server");
    // }, 500);
  }

  setupEventStreamReader(reader) {
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            console.log("Event stream closed by server");
            break;
          }
          if (value) {
            const msg = new TextDecoder().decode(value);
            try {
              const event = JSON.parse(msg);
              this.onServerEvent(event);
            } catch (e) {
              console.log("Non-JSON event message:", msg);
            }
          }
        }
      } catch (err) {
        console.error("Error reading from event stream:", err);
      }
    })();
  }

  async sendOverEventStream(data) {
    if (!this.eventStream) {
      console.error("Event stream not available");
      return;
    }

    try {
      const bytes =
        typeof data === "string" ? new TextEncoder().encode(data) : data;

      const len = bytes.length;
      const out = new Uint8Array(4 + len);
      const view = new DataView(out.buffer);
      view.setUint32(0, len, false);
      out.set(bytes, 4);
      await this.eventStream.writer.write(out);
    } catch (error) {
      console.error("Failed to send over event stream:", error);
      throw error;
    }
  }

  async sendEvent(eventData) {
    const eventJson = JSON.stringify(eventData);
    await this.sendOverEventStream(eventJson);
  }

  async sendPublisherState() {
    const stateEvent = {
      type: "PublisherState",
      streamId: this.streamId,
      hasCamera: this.hasCamera,
      hasMic: this.hasMic,
      cameraEnabled: this.hasCamera ? this.cameraEnabled : false,
      micEnabled: this.hasMic ? this.micEnabled : false,
      streamType: this.streamType, // 'camera' or 'display'
      timestamp: Date.now(),
    };

    await this.sendEvent(stateEvent);
    this.onStatusUpdate("Publisher state sent to server");
  }

  async createBidirectionalStream(channelName) {
    const stream = await this.webTransport.createBidirectionalStream();
    const readable = stream.readable;
    const writable = stream.writable;

    const writer = writable.getWriter();
    const reader = readable.getReader();

    this.publishStreams.set(channelName, {
      writer,
      reader,
      configSent: false,
      config: null,
    });

    console.log(
      `WebTransport bidirectional stream (${channelName}) established`
    );

    const initData = new TextEncoder().encode(channelName);
    await this.sendOverStream(channelName, initData);

    this.setupStreamReader(channelName, reader);

    console.log(`Stream created: ${channelName}`);
  }

  setupStreamReader(channelName, reader) {
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            console.log(`Stream ${channelName} closed by server`);
            break;
          }
          if (value) {
            const msg = new TextDecoder().decode(value);
            if (msg.startsWith("ack:") || msg.startsWith("config:")) {
              console.log(`${channelName} received:`, msg);
            }
          }
        }
      } catch (err) {
        console.error(`Error reading from stream ${channelName}:`, err);
      }
    })();
  }

  async sendOverStream(channelName, frameBytes) {
    const streamData = this.publishStreams.get(channelName);
    if (!streamData) {
      console.error(`Stream ${channelName} not found`);
      return;
    }

    try {
      const len = frameBytes.length;
      const out = new Uint8Array(4 + len);
      const view = new DataView(out.buffer);
      view.setUint32(0, len, false);
      out.set(frameBytes, 4);
      await streamData.writer.write(out);
    } catch (error) {
      console.error(`Failed to send over stream ${channelName}:`, error);
      throw error;
    }
  }

  async startStreaming() {
    // Start video capture
    await this.startVideoCapture();

    // Start audio streaming
    this.audioProcessor = await this.startOpusAudioStreaming();
  }

  async startVideoCapture() {
    if (!this.stream) {
      throw new Error("No media stream available");
    }

    this.initVideoEncoders();

    this.videoEncoders.forEach((encoderObj) => {
      console.log(
        `Configuring encoder for ${encoderObj.channelName}`,
        encoderObj,
        "config",
        encoderObj.config
      );
      encoderObj.encoder.configure(encoderObj.config);
    });

    const triggerWorker = new Worker("polyfills/triggerWorker.js");
    triggerWorker.postMessage({ frameRate: this.currentConfig.framerate });

    const track = this.stream.getVideoTracks()[0];
    console.log("Using video track:", track);
    this.videoProcessor = new MediaStreamTrackProcessor(
      track,
      triggerWorker,
      true
    );

    const reader = this.videoProcessor.readable.getReader();
    console.log("Video processor reader created:", reader);

    let frameCounter = 0;

    const cameraEncoders = Array.from(this.videoEncoders.entries()).filter(
      ([_, obj]) => obj.channelName.startsWith("cam")
    );

    // Process video frames
    (async () => {
      try {
        while (this.isPublishing) {
          const result = await reader.read();

          if (result.done) break;

          const frame = result.value;

          if (!window.videoBaseTimestamp) {
            window.videoBaseTimestamp = frame.timestamp;
          }

          if (!this.cameraEnabled) {
            console.log("Camera disabled, skipping frame");
            frame.close();
            continue;
          }

          frameCounter++;
          const keyFrame = frameCounter % 30 === 0;

          for (let i = 0; i < cameraEncoders.length; i++) {
            const [quality, encoderObj] = cameraEncoders[i];
            const isLastEncoder = i === cameraEncoders.length - 1;

            if (encoderObj.encoder.encodeQueueSize <= 2) {
              const frameToEncode = isLastEncoder
                ? frame
                : new VideoFrame(frame);
              encoderObj.encoder.encode(frameToEncode, { keyFrame });
              frameToEncode.close();
            }
          }
        }
      } catch (error) {
        this.onStatusUpdate(`Video processing error: ${error.message}`, true);
        console.error("Video capture error:", error);
      }
    })();
  }

  async startOpusAudioStreaming() {
    if (!this.stream) {
      throw new Error("No media stream available");
    }

    const audioTrack = this.stream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error("No audio track found in stream");
    }

    const audioRecorderOptions = {
      encoderApplication: 2051,
      encoderComplexity: 0,
      encoderFrameSize: 20,
      timeSlice: 100,
    };

    const audioRecorder = await this.initAudioRecorder(
      audioTrack,
      audioRecorderOptions
    );
    audioRecorder.ondataavailable = (typedArray) =>
      this.handleOpusAudioChunk(typedArray, "mic_48k");

    await audioRecorder.start({
      timeSlice: audioRecorderOptions.timeSlice,
    });

    return audioRecorder;
  }

  handleVideoChunk(chunk, metadata, quality, channelName) {
    const encoderObj = this.videoEncoders.get(quality);
    if (!encoderObj) return;

    const streamData = this.publishStreams.get(channelName);
    if (!streamData) return;

    if (metadata && metadata.decoderConfig && !encoderObj.metadataReady) {
      encoderObj.videoDecoderConfig = {
        codec: metadata.decoderConfig.codec,
        codedWidth: metadata.decoderConfig.codedWidth,
        codedHeight: metadata.decoderConfig.codedHeight,
        frameRate: this.currentConfig.framerate,
        description: metadata.decoderConfig.description,
      };
      encoderObj.metadataReady = true;
      console.warn(
        "Video config ready for",
        channelName,
        encoderObj.videoDecoderConfig
      );
      this.sendStreamConfig(
        channelName,
        encoderObj.videoDecoderConfig,
        "video"
      );
    }

    if (!streamData.configSent) return;

    const chunkData = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(chunkData);
    let type;
    switch (channelName) {
      case "cam_360p":
        type = chunk.type === "key" ? 0 : 1;
        break;
      case "cam_720p":
        type = chunk.type === "key" ? 2 : 3;
        break;
      case "screen_share_1080p":
        type = chunk.type === "key" ? 4 : 5;
        break;
      default:
        type = 8; // other
    }
    // const type = chunk.type === "key" ? "video-key" : "video-delta";

    const packet = this.createPacketWithHeader(
      chunkData,
      chunk.timestamp,
      type
    );

    this.sendOverStream(channelName, packet);
    this.sequenceNumber++;
  }

  handleOpusAudioChunk(typedArray, channelName) {
    if (!this.micEnabled) return;
    if (!this.isChannelOpen || !typedArray || typedArray.byteLength === 0)
      return;

    const streamData = this.publishStreams.get(channelName);
    if (!streamData) return;

    try {
      const dataArray = new Uint8Array(typedArray);
      // Check for Opus header "OggS"
      if (
        dataArray.length >= 4 &&
        dataArray[0] === 79 &&
        dataArray[1] === 103 &&
        dataArray[2] === 103 &&
        dataArray[3] === 83
      ) {
        if (!streamData.configSent && !streamData.config) {
          const description = this.createPacketWithHeader(
            dataArray,
            performance.now() * 1000,
            6
          );

          const audioConfig = {
            codec: "opus",
            sampleRate: 48000,
            numberOfChannels: 1,
            description: description,
          };

          streamData.config = audioConfig;
          this.sendStreamConfig(channelName, audioConfig, "audio");
        }

        // Initialize timing
        if (this.opusBaseTime === 0 && window.videoBaseTimestamp) {
          this.opusBaseTime = window.videoBaseTimestamp;
          window.audioStartPerfTime = performance.now();
          this.opusSamplesSent = 0;
          this.opusChunkCount = 0;
        } else if (this.opusBaseTime === 0 && !window.videoBaseTimestamp) {
          this.opusBaseTime = performance.now() * 1000;
          this.opusSamplesSent = 0;
          this.opusChunkCount = 0;
        }

        const timestamp =
          this.opusBaseTime +
          Math.floor((this.opusSamplesSent * 1000000) / this.kSampleRate);

        if (streamData.configSent) {
          const packet = this.createPacketWithHeader(dataArray, timestamp, 6);

          this.sendOverStream(channelName, packet);
        }
      }
    } catch (error) {
      console.error("Failed to send audio data:", error);
    }
  }

  async sendStreamConfig(channelName, config, mediaType) {
    const streamData = this.publishStreams.get(channelName);
    if (!streamData || streamData.configSent) return;

    try {
      let configPacket;

      if (mediaType === "video") {
        const vConfigUint8 = new Uint8Array(config.description);
        const vConfigBase64 = this.uint8ArrayToBase64(vConfigUint8);

        configPacket = {
          type: "StreamConfig",
          channelName: channelName,
          mediaType: "video",
          config: {
            codec: config.codec,
            codedWidth: config.codedWidth,
            codedHeight: config.codedHeight,
            frameRate: config.frameRate,
            quality: config.quality,
            description: vConfigBase64,
          },
        };
      } else if (mediaType === "audio") {
        const aConfigBase64 = this.uint8ArrayToBase64(
          new Uint8Array(config.description)
        );

        configPacket = {
          type: "StreamConfig",
          channelName: channelName,
          mediaType: "audio",
          config: {
            codec: config.codec,
            sampleRate: config.sampleRate,
            numberOfChannels: config.numberOfChannels,
            description: aConfigBase64,
          },
        };
      }
      console.log("send stream config", configPacket);
      const packet = new TextEncoder().encode(JSON.stringify(configPacket));
      await this.sendOverStream(channelName, packet);

      streamData.configSent = true;
      streamData.config = config;

      this.onStatusUpdate(`Config sent for stream: ${channelName}`);
    } catch (error) {
      console.error(`Failed to send config for ${channelName}:`, error);
    }
  }

  createPacketWithHeader(data, timestamp, type) {
    let adjustedTimestamp = timestamp;
    if (window.videoBaseTimestamp) {
      adjustedTimestamp = timestamp - window.videoBaseTimestamp;
    }

    let safeTimestamp = Math.floor(adjustedTimestamp / 1000);
    if (safeTimestamp < 0) safeTimestamp = 0;

    const HEADER_SIZE = 5;
    const MAX_TS = 0xffffffff;
    const MIN_TS = 0;

    if (safeTimestamp > MAX_TS) safeTimestamp = MAX_TS;
    if (safeTimestamp < MIN_TS) safeTimestamp = MIN_TS;

    const packet = new Uint8Array(
      HEADER_SIZE +
        (data instanceof ArrayBuffer ? data.byteLength : data.length)
    );
    // type mapping
    // video-360p-key = 0
    // video-360p-delta = 1
    // video-720p-key = 2
    // video-720p-delta = 3
    // video-1080p-key = 4
    // video-1080p-delta = 5
    // audio = 6
    // config = 7
    // other = 8

    packet[4] = type;

    const view = new DataView(packet.buffer, 0, 4);
    view.setUint32(0, safeTimestamp, false);

    packet.set(
      data instanceof ArrayBuffer ? new Uint8Array(data) : data,
      HEADER_SIZE
    );

    return packet;
  }

  uint8ArrayToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  async stop() {
    if (!this.isPublishing) {
      return;
    }

    try {
      this.isPublishing = false;

      // Close video encoders
      for (const [quality, encoderObj] of this.videoEncoders) {
        if (encoderObj.encoder && encoderObj.encoder.state !== "closed") {
          await encoderObj.encoder.flush();
          encoderObj.encoder.close();
        }
      }
      this.videoEncoders.clear();

      // Stop audio processor
      if (
        this.audioProcessor &&
        typeof this.audioProcessor.stop === "function"
      ) {
        await this.audioProcessor.stop();
        this.audioProcessor = null;
      }

      // Close all streams
      for (const [channelName, streamData] of this.publishStreams) {
        if (streamData.writer) {
          await streamData.writer.close();
        }
      }
      this.publishStreams.clear();

      // Close event stream
      if (this.eventStream && this.eventStream.writer) {
        await this.eventStream.writer.close();
        this.eventStream = null;
      }

      // Close WebTransport
      if (this.webTransport) {
        this.webTransport.close();
        this.webTransport = null;
      }

      // Stop all tracks
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }

      // Reset state
      this.isChannelOpen = false;
      this.sequenceNumber = 0;
      this.opusBaseTime = 0;
      this.opusSamplesSent = 0;
      this.opusChunkCount = 0;

      // Clear global variables
      window.videoBaseTimestamp = null;
      window.audioStartPerfTime = null;

      this.onStreamStop();
      this.onStatusUpdate("Publishing stopped");
    } catch (error) {
      this.onStatusUpdate(`Error stopping publishing: ${error.message}`, true);
      throw error;
    }
  }

  // Getters for state
  get isActive() {
    return this.isPublishing;
  }

  get streamInfo() {
    return {
      streamType: this.streamType,
      config: this.currentConfig,
      sequenceNumber: this.sequenceNumber,
      activeStreams: Array.from(this.publishStreams.keys()),
    };
  }
}
