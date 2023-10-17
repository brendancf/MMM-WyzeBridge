/* Magic Mirror
 * Node Helper: "MMM-WyzeBridge"
 *
 * By Andrés Vanegas <ukab72106@gmail.com>
 * MIT Licensed.
 */

var NodeHelper = require("node_helper");
const Log = require("../../js/logger.js");
const { createProxyMiddleware } = require("http-proxy-middleware");
const axios = require("axios").default;
const nocache = require('nocache');

module.exports = NodeHelper.create({
	name: "MMM-WyzeBridge",
	urlPrefix: null,
	logPrefix: "MMM-WyzeBridge :: ",
	allowedKeys: [
		"connected",
		"enabled",
		"firmware_ver",
		"name_uri",
		"nickname",
		"product_model",
		"status"
	],
	readyState: false,
	clientInstances: {},

	start: function () {
		this.readyState = false;
		Log.info(this.logPrefix + "Started");
		this.sendNotification("SET_MESSAGE", null, { status: "LOADING" });
	},

	sendNotification(notification, instanceConfig, payload) {

		const id = instanceConfig ? instanceConfig.id : null
		
		this.sendSocketNotification(this.name + "-" + notification, {id, ...payload});
	},

	socketNotificationReceived: function (notification, payload) {
		var self = this;
		notification = notification.replace(this.name + "-", "");

		switch (notification) {
			case "SET_CONFIG":

				if (typeof(clientInstances[payload.id]) === "undefined") {
					Log.info(this.logPrefix + "Working notification system. Notification:", notification, "payload: ", payload);
					const config = payload;

					clientInstances[config.id] = config

					config.cameras = config.cameras || []
					config.index = 0
					this.urlPrefix = config.__protocol + "//localhost:" + config.__port + "/" + this.name;
					this.setProxy(config);
					this.swapCamera(config);
				} else {
					this.showCamera(payload)
				}

				break;
		}
	},

	// this you can create extra routes for your module
	setProxy: function (config) {
		var self = this;
		this.expressApp.set("etag", false);
		this.expressApp.use("/" + this.name + "/proxy/*",
			nocache(),
			createProxyMiddleware({
				target: config.targetHost + ":" + config.targetPort, // target host with the same base path
				changeOrigin: true, // needed for virtual hosted sites
				pathRewrite: function (path, _) {
					return path.replace(new RegExp("^/" + self.name + "/proxy/"), "/");
				},
			})
		);

		this.expressApp.use("/" + this.name + "/stream/*",
			nocache(),
			createProxyMiddleware({
				target: config.targetHost + ":8888", // target host with the same base path
				changeOrigin: true, // needed for virtual hosted sites
				pathRewrite: function (path, _) {
					return path.replace(new RegExp("^/" + self.name + "/stream/"), "/");
				},
			})
		);

		this.getCameras(config);
	},

	processCameras: function (config, data) {
		var self = this;
		if (typeof data !== "object" || !data.hasOwnProperty("cameras")) {
			data = { cameras: {} };
		}

		config.cameras = [];

		for (var cameraName in data.cameras) {

			Log.info(cameraName)

			const __canShowCamera = (
				// All cameras should be shown or
				config.filter == 0
				// Camera match exactly a filter as string
				|| config.filter.includes(cameraName)
				// Camera match a valid pattern
				//|| config.filter.map(p => new RegExp(p, "gi")).some(p => cameraName.match(p))
			);

			if (__canShowCamera) {

				Log.info(`Add camera ${cameraName}`)

				var cameraData = {
					image_url: "/proxy/" + data.cameras[cameraName].img_url,
					video_url: "/stream/" + data.cameras[cameraName].name_uri + "/stream.m3u8",
				};
				for (camAttribute of this.allowedKeys) {
					cameraData[camAttribute] = data.cameras[cameraName][camAttribute];
				}
				config.cameras.push(cameraData);
			} else {
				Log.info(`Skipping camera ${cameraName}`)
			}
		}
		config.cameras.sort(function (a, b) {
			if (a.nickname < b.nickname) { return -1; }
			if (a.nickname > b.nickname) { return 1; }
			return 0;
		});

		camerasReceived = config.cameras.map(x => x.nickname);
		camerasAlreadyDetected = config.cameras.map(x => x.nickname);

		var removedCameras = camerasAlreadyDetected.filter(x => !camerasReceived.includes(x));
		var newCameras = camerasReceived.filter(x => !camerasAlreadyDetected.includes(x));

		if (newCameras.length + removedCameras.length > 0) {
			Log.info(self.logPrefix + "Changes received in cameras");
			config.cameras = cameras;
			config.index = config.index > (config.cameras.length - 1) ? 0 : config.index;
			newCameras.forEach(x => Log.log(self.logPrefix + x + " camera detected"));
			removedCameras.forEach(x => Log.log(self.logPrefix + x + " camera removed"));
			this.showCamera(config)
		}
	},

	changeIndex: function (config) {
		if (this.readyState && config.cameras.length > 0) {
			if (config.index < (config.cameras.length - 1)) {
				config.index++;
			} else {
				config.index = 0;
			}
		}
	},

	showCamera: function (config) {
		var self = this;

		if (!this.readyState) {
			Log.info(this.logPrefix + "Still loading");
			this.sendNotification("SET_MESSAGE", config, { status: "LOADING" });
		}
		else if (config.cameras && config.cameras.length == 0) {
			Log.info(this.logPrefix + "No cameras found. skipping");
			this.sendNotification("SET_MESSAGE", config, { status: "NO_CAMS" });
		}
		else {
			Log.info(this.logPrefix + "Showing camera " + config.cameras[config.index].nickname);
			this.sendNotification("SET_CAMERA", config, { camera: config.cameras[config.index] });
		}
	},

	swapCamera: function (config) {
		var self = this;
		this.showCamera(config);
		this.changeIndex(config);

		setTimeout(function () {
			self.swapCamera(config);
		}, this.readyState ? config.updateInterval : config.retryDelay);
	},

	// Test another function
	getCameras: function (config) {
		var self = this;

		Log.log(self.logPrefix + `Requesting cameras... ${this.urlPrefix}`);

		axios.get(this.urlPrefix + "/proxy/api")
			.then(function (response) {
				self.processCameras(config, response.data);
			})
			.catch(function (error) {
				config.cameras = [];
				Log.error(self.logPrefix + error.message);
			})
			.then(function () {
				self.readyState = true;
				self.sendNotification("READY_STATE", config, self.readyState);
				self.sendNotification("CAMERAS_UPDATED", config, { camera_count: config.cameras.length });

				Log.log(self.logPrefix + "Request cameras finished");
				setTimeout(function () { self.getCameras(config); }, config.retryDelay);
			});
	}
});
