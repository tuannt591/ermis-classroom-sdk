/**
 * Ermis Classroom SDK
 * Main entry point for the SDK
 */

import ErmisClient from "./core/ErmisClient.js";
import Room from "./core/Room.js";
import SubRoom from "./core/SubRoom.js";
import Participant from "./core/Participant.js";
import ApiClient from "./api/ApiClient.js";
import EventEmitter from "./events/EventEmitter.js";

/**
 * SDK Version
 */
export const VERSION = "1.0.0";

/**
 * Main SDK Class - Similar to LiveKit pattern
 */
class ErmisClassroom {
  /**
   * Create a new Ermis Classroom client
   * @param {Object} config - Configuration options
   * @returns {ErmisClient} - New client instance
   */
  static create(config = {}) {
    return new ErmisClient(config);
  }

  /**
   * Connect and authenticate user
   * @param {string} serverUrl - Server URL
   * @param {string} userId - User identifier
   * @param {Object} options - Connection options
   * @returns {Promise<ErmisClient>} - Connected client
   */
  static async connect(serverUrl, userId, options = {}) {
    const config = {
      host: serverUrl.replace(/^https?:\/\//, ""),
      ...options,
    };

    const client = new ErmisClient(config);
    await client.authenticate(userId);

    return client;
  }

  /**
   * Get SDK version
   */
  static get version() {
    return VERSION;
  }

  /**
   * Get available events
   */
  static get events() {
    return {
      // Client events
      CLIENT_AUTHENTICATED: "authenticated",
      CLIENT_AUTHENTICATION_FAILED: "authenticationFailed",
      CLIENT_LOGGED_OUT: "loggedOut",
      CLIENT_CONNECTION_STATUS_CHANGED: "connectionStatusChanged",

      // Room events
      ROOM_CREATED: "roomCreated",
      ROOM_JOINED: "roomJoined",
      ROOM_LEFT: "roomLeft",

      // Participant events
      PARTICIPANT_ADDED: "participantAdded",
      PARTICIPANT_REMOVED: "participantRemoved",
      PARTICIPANT_PINNED: "participantPinned",
      PARTICIPANT_UNPINNED: "participantUnpinned",
      AUDIO_TOGGLED: "audioToggled",
      VIDEO_TOGGLED: "videoToggled",

      // Sub room events
      SUB_ROOM_CREATED: "subRoomCreated",
      SUB_ROOM_JOINED: "subRoomJoined",
      SUB_ROOM_LEFT: "subRoomLeft",
      SUB_ROOM_SWITCHED: "subRoomSwitched",

      // Media stream events
      LOCAL_STREAM_READY: "localStreamReady",
      REMOTE_STREAM_READY: "remoteStreamReady",
      STREAM_REMOVED: "streamRemoved",

      // Error events
      ERROR: "error",
    };
  }

  /**
   * Media device utilities
   */
  static get MediaDevices() {
    return {
      /**
       * Get available media devices
       */
      async getDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) {
          throw new Error("Media devices not supported");
        }

        const devices = await navigator.mediaDevices.enumerateDevices();

        return {
          cameras: devices.filter((d) => d.kind === "videoinput"),
          microphones: devices.filter((d) => d.kind === "audioinput"),
          speakers: devices.filter((d) => d.kind === "audiooutput"),
        };
      },

      /**
       * Get user media with constraints
       */
      async getUserMedia(constraints = { video: true, audio: true }) {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("getUserMedia not supported");
        }

        return await navigator.mediaDevices.getUserMedia(constraints);
      },

      /**
       * Check for media permissions
       */
      async checkPermissions() {
        const permissions = {};

        if (navigator.permissions) {
          try {
            permissions.camera = await navigator.permissions.query({
              name: "camera",
            });
            permissions.microphone = await navigator.permissions.query({
              name: "microphone",
            });
          } catch (error) {
            console.warn("Permission check failed:", error);
          }
        }

        return permissions;
      },
    };
  }

  /**
   * Room types constants
   */
  static get RoomTypes() {
    return {
      MAIN: "main",
      BREAKOUT: "breakout",
      PRESENTATION: "presentation",
      DISCUSSION: "discussion",
    };
  }

  /**
   * Connection status constants
   */
  static get ConnectionStatus() {
    return {
      DISCONNECTED: "disconnected",
      CONNECTING: "connecting",
      CONNECTED: "connected",
      FAILED: "failed",
    };
  }

  /**
   * Participant roles constants
   */
  static get ParticipantRoles() {
    return {
      OWNER: "owner",
      MODERATOR: "moderator",
      PARTICIPANT: "participant",
      OBSERVER: "observer",
    };
  }
}

/**
 * Named exports for individual classes
 */
export { ErmisClient, Room, SubRoom, Participant, ApiClient, EventEmitter };

/**
 * Default export - Main SDK class
 */
export default ErmisClassroom;
