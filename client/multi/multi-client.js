var fs = require("fs")
var path = require("path")
var child_process = require("child_process")

var multiConfigDir = path.join(__dirname,"configs")
var tmpConfigDir = path.join(__dirname,"tmp")

var configFiles = fs.readdirSync(multiConfigDir)
var extraDefault = undefined
configFiles = configFiles.filter((file)=>{
	var name = path.parse(file).name
	if(name == "default"){
		extraDefault = file
		return false
	}
	if(name == "multidefault"){
		throw new Error("Config file can not have name multidefault")
	}
	if(file == ".gitkeep"){
		return false
	}
	return true
})

var subProcesses = []
for(var x in configFiles){
	var file = configFiles[x]
	var configPath = path.join(tmpConfigDir,file)
	fs.mkdirSync(configPath,{recursive:true})
	fs.cpSync(path.join(__dirname,"../config/default.yaml"), path.join(configPath,"default.yaml"))
	if(extraDefault){
		var extraDefaultExt = path.parse(extraDefault).ext
		fs.cpSync(path.join(multiConfigDir, extraDefault), path.join(configPath, "multidefault" + extraDefaultExt))
	}
	var nameParsed = path.parse(file)
	var env = Object.assign({}, process.env)
	env.NODE_ENV = "multidefault"
	env.NODE_CONFIG_DIR = path.resolve(configPath)
	fs.cpSync(path.join(multiConfigDir, file), path.join(configPath, "local" + nameParsed.ext))
	subProcesses.push(child_process.spawn(process.argv0, [path.resolve(path.join(__dirname,"../client.js"))],{
		stdio:["ignore","inherit","inherit"],
		env: env,
	}))
}

process.once("SIGINT", function (code) {
	shutdown()
});
process.once("SIGTERM", function (code) {
	shutdown()
});

async function shutdown(){
	console.log("shutting down all clients")
	for(var x in subProcesses){
		subProcesses[x].kill("SIGTERM")
	}
}