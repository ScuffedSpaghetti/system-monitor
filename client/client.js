//@ts-check
var os = require("os")
var fs = require("fs")
var WebSocket = require("ws")
if(!process.env["NODE_CONFIG_DIR"]){
	process.env["NODE_CONFIG_DIR"] = __dirname + "/config/"
}

//@ts-ignore
//require("module")._cache["js-yaml"] =  require("js-yaml")
var config = require("config")

var NvidiaGPU = require("./devices/nvidia")
var GenericCPU = require("./devices/cpu-generic")
var LinuxCPU = require("./devices/cpu-linux")
var GenericRAM = require("./devices/memory-generic")
var LinuxRAM = require("./devices/memory-linux")
var LinuxNetwork = require("./devices/network-linux")
var WindowsNetwork = require("./devices/network-windows")
var ExtraDevice = require("./devices/extra-device")
var LinuxGPU = require("./devices/gpu-linux")
var WindowsGPU = require("./devices/gpu-windows")
var GenericSystem = require("./devices/system-info")



function recursiveRecordTotal(totalObj, obj){
	for(var x in obj){
		if(x.endsWith("_ignore") || obj[x+"_ignore"]){
			// ignore if ends with ignore or if the same key with the addition of _ignore exists
			continue
		}
		var val = obj[x]
		if((totalObj[x] == undefined || totalObj[x].type == "string") && typeof val == "string"){
			totalObj[x] = totalObj[x] || {type:"string", strings:new Set()}
			totalObj[x].strings.add(val)
		}
		if((totalObj[x] == undefined || totalObj[x].type == "number") && typeof val == "number"){
			totalObj[x] = totalObj[x] || {type:"number", numbers:[]}
			if(obj[x + "_reduce_overwrite"]){
				totalObj[x].numbers = []
			}
			totalObj[x].numbers.push(val)
		}
		if((totalObj[x] == undefined || totalObj[x].type == "object" ||  totalObj[x].type == "array") && typeof val == "object"){
			if(val instanceof Array){
				totalObj[x] = totalObj[x] || {type:"array", object:[]}
			}else{
				totalObj[x] = totalObj[x] || {type:"object", object:Object.create(null)}
			}
			recursiveRecordTotal(totalObj[x].object, val)
		}
	}
}

function recursiveFinalTotal(totalRecordObj, total, settings){
	for(var x in totalRecordObj){
		var val = totalRecordObj[x]
		if(settings.ignoreKeys && settings.ignoreKeys.includes(x)){
			continue
		}
		if(val.type == "string"){
			total[x] = ""
			var separator = ""
			val.strings.forEach((str)=>{
				total[x] += separator + str
				separator = " | "
			})
		}
		if(val.type == "number"){
			var numbers = val.numbers.filter((num) => isFinite(num))
			if(numbers.length > 0){
				var method = "ave"
				if(totalRecordObj[x+"_reduce_min"]){
					method = "min"
				}
				if(totalRecordObj[x+"_reduce_max"]){
					method = "max"
				}
				if(totalRecordObj[x+"_reduce_add"]){
					method = "add"
				}
				if(totalRecordObj[x+"_reduce_overwrite"]){
					method = "over"
				}
				
				
				switch(method){
					case "min":
						var outMin = numbers[0]
						for(var y in numbers){
							outMin = Math.min(outMin, numbers[y])
						}
						total[x] = outMin
						break
					case "max":
						var outMax = numbers[0]
						for(var y in numbers){
							outMax = Math.max(outMax, numbers[y])
						}
						total[x] = outMax
						break
					case "over":
						total[x] = numbers[0]
						break
					case "ave":
					case "add":
					default:
						var outTotal = 0
						for(var y in numbers){
							outTotal += numbers[y]
						}
						if(!(settings.addKeys && settings.addKeys.includes(x) || method == "add")){
							outTotal /= numbers.length
						}
						total[x] = outTotal
				}
			}else{
				total[x] = val.numbers[0]
			}
			if(settings.maxPrecision > -1){
				var mult = Math.pow(10,settings.maxPrecision)
				total[x] = Math.round(total[x] * mult) / mult
			}
		}
		if(val.type == "object"){
			total[x] = Object.create(null)
			recursiveFinalTotal(val.object,total[x], settings)
		}
		if(val.type == "array"){
			if(settings.ignoreSingleArrayKeys && settings.ignoreSingleArrayKeys.includes(x) && val.length <= 1){
				continue
			}
			total[x] = []
			recursiveFinalTotal(val.object,total[x], settings)
		}
	}
}

function averageObjects(arr,settings){
	settings = settings || {}
	
	var totalRecordObj = Object.create(null)
	for(var x in arr){
		recursiveRecordTotal(totalRecordObj, arr[x])
	}
	var total = Object.create(null)
	//console.log(totalRecordObj)
	recursiveFinalTotal(totalRecordObj, total, settings)
	return total
}





async function getValidDevices(){
	var devices = {}
	if(!config.get("hideDefaultDevices")){
		devices.cpu = new GenericCPU()
		devices.memory = new GenericRAM()
		devices.system = new GenericSystem()
		switch(process.platform){
			case "linux":
				devices.cpu = new LinuxCPU()
				devices.memory = new LinuxRAM()
				devices.network = new LinuxNetwork(config.get("showVirtualNetworkInterfaces"))
				devices.gpu = new LinuxGPU()
			break
			case "win32":
				devices.network = new WindowsNetwork()
				devices.gpu = new WindowsGPU()
			break
		}
		var nvidia = new NvidiaGPU()
		if((await nvidia.getDeviceInfo()).length > 0){
			devices.gpu = nvidia
		}
	}
	
	
	
	var extraDevices = config.get("extraDevices").filter((extraDevice) => {return extraDevice.type != "example"})
	
	if(extraDevices.length > 0){
		devices.extra = []
		for(var x in extraDevices){
			var extraDeviceOptions = extraDevices[x]
			try{
				devices.extra.push(new ExtraDevice(extraDeviceOptions))
			}catch(err){
				console.error(err)
				console.error("Failed to load custom device " + extraDeviceOptions.type)
			}
		}
	}
	
	return devices
}

async function queryDevices(devices,options){
	options = options || {}
	
	async function queryDevice(device, info, existingDevInfo){
		var individuals = undefined
		try{
			individuals = await device.getDeviceInfo()
		}catch(err){
			console.error(err)
			console.error("A device reader threw an error! This is a sign that something was programed wrong or there is a system failure.\n" +
				"This message should never appear during normal operation.")
		}
		if(individuals && individuals.length > 0){
			var devInfoAll = existingDevInfo || []
			devInfoAll = devInfoAll.concat(individuals)
			var devInfo = {}
			devInfo.average = averageObjects(devInfoAll,{
				addKeys:["bytes","bytes_total", "watts","watts_limit","rx_bytes","rx_bytes_limit","tx_bytes","tx_bytes_limit"],
				ignoreSingleArrayKeys:["individual"],
			})
			for(var x in individuals){
				var individual = individuals[x]
				if(individual?.power?.watts != undefined && !individual?.power_ignore){
					info.power = info.power || {average:{watts:0}}
					info.power.average.watts += individual.power.watts
				}
			}
			if(options.individual !== false /*&& devInfoAll.length > 1*/){
				devInfo.individual = devInfoAll
			}
			return devInfo
		}
	}
	
	var info = {}
	for(var x in devices){
		if(x == "extra"){
			continue
		}
		var devInfo = await queryDevice(devices[x], info)
		if(devInfo){
			if(x == "cpu"){
				devInfo.individual_usage = devInfo.individual.map((a) => a.usage)
				devInfo.individual=undefined
			}
			info[x] = devInfo
		}
	}
	if(devices.extra){
		info.extra = {}
		// query extra devices and merge any that have the same type
		for(var x in devices.extra){
			var extraDevice = devices.extra[x]
			var devInfo = await queryDevice(extraDevice, info, info.extra[extraDevice.type]?.individual)
			
			if(devInfo){
				if(devInfo.average.outline && devInfo.average.outline.overview){
					// this will not correctly average if multiple types of devices have outlines
					info.outline = {average: devInfo.average.outline}
				}
				info.extra[extraDevice.type] = devInfo
			}
		}
	}
	
	return info
}





void (async function(){
	var devices = await getValidDevices()
	
	var outHTML = document.createElement("pre")
	document.body.appendChild(outHTML)
	setInterval(async ()=>{
		//console.log((await cpu.getDeviceInfo())[0])
		//console.log(await queryDevices(devices))
		//console.log(JSON.stringify(await queryDevices(devices,{individual:false}),null,2))
		outHTML.innerText = JSON.stringify(await queryDevices(devices,{individual:false}),null,2)
	},1000/4)
	
})

var webSocketAddress = (config.get("serverSecure")?"wss":"ws")+"://"+config.get("serverAddress")
var password = config.get("password")

if(config.get("verbose")){
	process.env.VERBOSE = "true"
}

let running = true
let currentCloseFunction = undefined

console.log("connecting to " + webSocketAddress)
void (async function(){
	var devices = await getValidDevices()
	while(running){
		await /** @type {Promise<void>} */(new Promise((resolve)=>{
			var websocket = new WebSocket(webSocketAddress)
			var interval = undefined
			var intervalAlive = undefined
			var lastSeen = Date.now() / 1000
			function close(){
				if(interval){
					clearInterval(interval)
				}
				if(intervalAlive){
					clearInterval(intervalAlive)
				}
				if(running){
					setTimeout(()=>{
						resolve()
					},1000)
				}else{
					resolve()
				}
				websocket.close()
				if(process.env.VERBOSE){
					console.error("Socket disconnected at "+Date())
				}
				currentCloseFunction = undefined
			}
			currentCloseFunction = close
			websocket.onerror = close
			websocket.onclose = close
			function sendJSON(obj){
				if(websocket.readyState == websocket.OPEN){
					websocket.send(JSON.stringify(obj))
				}
			}
			websocket.on("pong",()=>{
				lastSeen = Date.now() / 1000
			})
			intervalAlive = setInterval(async ()=>{
				var now = Date.now() / 1000
				if(now - lastSeen > 200){
					if(process.env.VERBOSE){
						console.log('socket ping timeout, reconnecting')
					}
					close()
				}
			},10000)
			websocket.onopen = async ()=>{
				sendJSON({
					type:"init_system",
					hostname:config.get("customName") || os.hostname(),
					password:password,
				})
				interval = setInterval(async ()=>{
					var info = await queryDevices(devices)
					//console.log(info)
					sendJSON({
						type:"info",
						info:info
					})
					websocket.ping()
				//introduce some randomness to interval times so that nodes send at different times
				},1000 - Math.random() * 100)
				//@ts-ignore
				websocket._socket.setKeepAlive(true, 10000)
				//@ts-ignore
				websocket._socket.setTimeout(30000)
				//@ts-ignore
				websocket._socket.on('timeout', () => {
					if(process.env.VERBOSE){
						console.log('socket timeout, reconnecting')
					}
					close()
				})
			}
			
		}))
	}
})()


process.once("SIGINT", function (code) {
	shutdown()
});
process.once("SIGTERM", function (code) {
	shutdown()
});

async function shutdown(){
	console.log("shutting down client")
	running = false
	if(currentCloseFunction){
		currentCloseFunction()
	}
}