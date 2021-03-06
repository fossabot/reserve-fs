'use strict'

const fs = require('fs')
const path = require('path')
const util = require('util')

const readApis = 'readdir,readFile,stat'.split(',')
const writeApis = 'mkdir,rmdir,unlink,writeFile'.split(',')

const fsAsync = {}
readApis.concat(writeApis).forEach(api => {
  fsAsync[api] = util.promisify(fs[api])
})

const client = require('./client')
const clientTemplate = `(${client.toString()}())`

function readBody (request) {
  return new Promise((resolve, reject) => {
    const buffer = []
    request
      .on('data', chunk => buffer.push(chunk.toString()))
      .on('error', reject)
      .on('end', () => resolve(buffer.join('')))
  })
}

function send (response, answer) {
  response.writeHead(200, {
    'Content-Type': 'application/javascript',
    'Content-Length': answer.length
  })
  response.end(answer)
}

const wrappers = {}

function members (target, source, names) {
  names.forEach(name => {
    target[name] = source[name]
  })
}

function methods (target, source, names) {
  names.forEach(name => {
    target[`_${name}`] = source[name]()
  })
}

const direntMethods = 'isBlockDevice,isCharacterDevice,isDirectory,isFIFO,isFile,isSocket,isSymbolicLink'.split(',')
wrappers.readdir = result => {
  if (result instanceof fs.Dirent) {
    const dirent = { $class: 'Dirent', name: result.name }
    methods(dirent, result, direntMethods)
    return dirent
  }
  return result
}

wrappers.readFile = result => result.toString()

const statMembers = 'dev,ino,mode,nlink,uid,gid,rdev,size,blksize,blocks,atimeMs,mtimeMs,ctimeMs,birthtimeMs'.split(',')
wrappers.stat = result => {
  const stat = { $class: 'Stat' }
  methods(stat, result, direntMethods)
  members(stat, result, statMembers)
  return stat
}

function wrap (api, result) {
  const wrapper = wrappers[api]
  if (wrapper) {
    return wrapper(result)
  }
  return result
}

module.exports = {
  async redirect ({ mapping, match, redirect, request, response }) {
    const method = request.method
    let allApis = readApis
    if (!mapping['read-only']) {
      allApis = allApis.concat(writeApis)
    }

    if (method === 'GET') {
      const clientString = clientTemplate
        .replace('<APIS>', allApis.join(','))
        .replace('<NAME>', mapping['client-name'] || 'fs')
        .replace('<URL>', request.url)
      send(response, clientString)
      return
    }

    if (method === 'POST') {
      const body = await readBody(request)
      const call = JSON.parse(body)
      const api = call.api
      if (!allApis.includes(api)) {
        return 404
      }
      call.args[0] = path.join(redirect, call.args[0])
      if (!call.args[0].startsWith(redirect)) { // Use of .. to climb up the hierarchy
        return 403
      }
      return fsAsync[api].apply(fs, call.args)
        .then(result => {
          if (Array.isArray(result)) {
            return result.map(wrap.bind(null, api))
          }
          return wrap(api, result)
        })
        .then(result => JSON.stringify({ result }))
        .catch(err => JSON.stringify({ err: err.message }))
        .then(answer => send(response, answer))
    }

    return 500
  }
}
