import fs from 'fs'
import tar from 'tar'
import http, { Server } from 'http'
import os from 'os'
import path from 'path'
import { URL } from 'url'
import { v4 as uuid } from 'uuid'
import { checkFileSha1, DependenciesInstaller, DependencyItem, findItem, getModuleInfo, getRegistries, getVersion, readDependencies, shouldRetry, untar, VersionInfo } from '../../extension/dependency'
import { Dependencies } from '../../extension/installer'
import { writeJson, remove, loadJson } from '../../util/fs'
import helper, { getPort } from '../helper'

process.env.NO_PROXY = '*'

describe('utils', () => {
  it('should getRegistries', () => {
    let u = new URL('https://registry.npmjs.org')
    expect(getRegistries(u).length).toBe(2)
    u = new URL('https://registry.yarnpkg.com')
    expect(getRegistries(u).length).toBe(2)
    u = new URL('https://example.com')
    expect(getRegistries(u).length).toBe(3)
  })

  it('should checkFileSha1', async () => {
    let not_exists = path.join(os.tmpdir(), 'not_exists')
    let checked = await checkFileSha1(not_exists, 'shasum')
    expect(checked).toBe(false)
    let tarfile = path.resolve(__dirname, '../test.tar.gz')
    checked = await checkFileSha1(tarfile, 'bf0d88712fc3dbf6e3ab9a6968c0b4232779dbc4')
    expect(checked).toBe(true)
  })

  it('should untar files', async () => {
    let tarfile = path.resolve(__dirname, '../test.tar.gz')
    let folder = path.join(os.tmpdir(), `test-${uuid()}`)
    await untar(folder, tarfile, 0)
    let file = path.join(folder, 'test.js')
    expect(fs.existsSync(file)).toBe(true)
    await remove(folder)
  })

  it('should throw on untar error', async () => {
    let fn = async () => {
      let file = path.join(os.tmpdir(), `note_exists_${uuid()}`)
      let folder = path.join(os.tmpdir(), `test-${uuid()}`)
      await untar(folder, file, 0)
    }
    await expect(fn()).rejects.toThrow(Error)
  })

  it('should throw when item not found', async () => {
    expect(() => {
      findItem('name', '^1.0.1', [])
    }).toThrow()
  })

  it('should getModuleInfo', () => {
    expect(() => {
      getModuleInfo('{')
    }).toThrow()
    expect(() => {
      getModuleInfo('{}')
    }).toThrow()
    expect(() => {
      getModuleInfo('{"name": "name"}')
    }).toThrow()
    let obj: any = { name: 'name', version: '1.0.0', versions: {} }
    expect(getModuleInfo(JSON.stringify(obj))).toBeDefined()
    obj = { name: 'name', 'dist-tags': { latest: '1.0.0' }, versions: {} }
    expect(getModuleInfo(JSON.stringify(obj))).toBeDefined()
  })

  it('should check retry', () => {
    expect(shouldRetry({})).toBe(false)
    expect(shouldRetry({ message: 'message' })).toBe(false)
    expect(shouldRetry({ message: 'timeout' })).toBe(true)
    expect(shouldRetry({ message: 'ECONNRESET' })).toBe(true)
  })

  it('should readDependencies', () => {
    let dir = path.join(os.tmpdir(), uuid())
    fs.mkdirSync(dir, { recursive: true })
    let filepath = path.join(dir, 'package.json')
    writeJson(filepath, { dependencies: { "coc.nvim": ">= 0.0.80", "is-number": "^1.0.0" } })
    let res = readDependencies(dir)
    expect(res).toEqual({ 'is-number': '^1.0.0' })
  })

  it('should getVersion', () => {
    expect(getVersion('>= 1.0.0', ['1.0.0', '2.0.0', '2.0.1'], '2.0.1')).toBe('2.0.1')
    expect(getVersion('^1.0.0', ['1.0.0', '1.1.0', '2.0.1'])).toBe('1.1.0')
    expect(getVersion('^3.0.0', ['1.0.0'])).toBeUndefined()
  })
})

describe('DependenciesInstaller', () => {
  let httpPort: number
  let server: Server
  let jsonResponses: Map<string, string> = new Map()
  let url: URL
  let dirs: string[] = []
  let createFiles = false
  let timer

  beforeAll(async () => {
    httpPort = await getPort()
    url = new URL(`http://127.0.0.1:${httpPort}`)
    server = await createServer(httpPort)
  })

  afterEach(async () => {
    jsonResponses.clear()
    for (let dir of dirs) {
      await remove(dir)
    }
    dirs = []
  })

  afterAll(() => {
    clearTimeout(timer)
    if (server) server.close()
  })

  async function createTarFile(name: string, version: string): Promise<string> {
    let folder = path.join(os.tmpdir(), uuid())
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'index.js'), '', 'utf8')
    writeJson(path.join(folder, 'package.json'), { name, version, dependencies: {} })
    let file = path.join(os.tmpdir(), uuid(), `${name}.${version}.tgz`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    await tar.create({ file, gzip: true, cwd: path.dirname(folder) }, [path.basename(folder)])
    return file
  }

  async function createServer(port: number): Promise<Server> {
    return await new Promise(resolve => {
      const server = http.createServer(async (req, res) => {
        for (let [url, text] of jsonResponses.entries()) {
          if (req.url == url) {
            res.writeHead(200, { 'Content-Type': 'application/json;charset=utf8' })
            res.end(text)
            return
          }
        }
        if (req.url.endsWith('/slow')) {
          timer = setTimeout(() => {
            res.writeHead(100)
            res.end('abc')
          }, 300)
          return
        }
        if (req.url.endsWith('.tgz')) {
          res.setHeader('Content-Disposition', 'attachment; filename="file.tgz"')
          res.setHeader('Content-Type', 'application/octet-stream')
          let tarfile: string
          if (createFiles) {
            let parts = req.url.slice(1).replace(/\.tgz/, '').split('-')
            tarfile = await createTarFile(parts[0], parts[1])
          } else {
            tarfile = path.resolve(__dirname, '../test.tar.gz')
          }
          let stat = fs.statSync(tarfile)
          res.setHeader('Content-Length', stat.size)
          res.writeHead(200)
          let stream = fs.createReadStream(tarfile)
          stream.pipe(res)
        }
      })
      server.listen(port, () => {
        resolve(server)
      })
    })
  }

  function create(root?: string, onMessage?: (msg: string) => void): DependenciesInstaller {
    if (!root) {
      root = path.join(os.tmpdir(), uuid())
      fs.mkdirSync(root)
      dirs.push(root)
    }
    let registry = new URL(`http://127.0.0.1:${httpPort}`)
    onMessage = onMessage ?? function() {}
    return new DependenciesInstaller(registry, root, onMessage)
  }

  function createVersion(name: string, version: string, dependencies?: Dependencies): VersionInfo {
    return {
      name,
      version,
      dependencies,
      dist: {
        shasum: '',
        integrity: '',
        tarball: `http://127.0.0.1:${httpPort}/${name}-${version}.tgz`,
      }
    }
  }

  function addJsonData(): void {
    // a => b, c, d
    // c => b, d
    // b => d
    jsonResponses.set('/a', JSON.stringify({
      name: 'a',
      versions: {
        '0.0.1': createVersion('a', '0.0.1', { b: '^1.0.0', c: '^2.0.0', d: '>= 0.0.1' })
      }
    }))
    jsonResponses.set('/b', JSON.stringify({
      name: 'b',
      versions: {
        '1.0.0': createVersion('b', '1.0.0', {}),
        '2.0.0': createVersion('b', '2.0.0', { d: '^1.0.0' }),
        '3.0.0': createVersion('b', '3.0.0', { d: '^1.0.0' }),
      }
    }))
    jsonResponses.set('/c', JSON.stringify({
      name: 'c',
      versions: {
        '1.0.0': createVersion('c', '1.0.0', {}),
        '2.0.0': createVersion('c', '2.0.0', { b: '^2.0.0', d: '^1.0.0' }),
        '3.0.0': createVersion('c', '3.0.0', { b: '^3.0.0', d: '^1.0.0' }),
      }
    }))
    jsonResponses.set('/d', JSON.stringify({
      name: 'd',
      versions: {
        '1.0.0': createVersion('d', '1.0.0')
      }
    }))
  }

  it('should retry fetch', async () => {
    let install = create()
    let fn = async () => {
      await install.fetch(new URL('/', url), { timeout: 10 }, 3)
    }
    await expect(fn()).rejects.toThrow(Error)
    jsonResponses.set('/json', '{"result": "ok"}')
    let res = await install.fetch(new URL('/json', url), {}, 1)
    expect(res).toEqual({ result: 'ok' })
  })

  it('should cancel request', async () => {
    let install = create()
    let p = install.fetch(new URL('/slow', url), {}, 1)
    await helper.wait(10)
    let fn = async () => {
      install.cancel()
      await p
    }
    await expect(fn()).rejects.toThrow(Error)
  })

  it('should throw when unable to load info', async () => {
    let install = create()
    let fn = async () => {
      await install.loadInfo(url, 'foo', 10)
    }
    await expect(fn()).rejects.toThrow(Error)
  })

  it('should fetchInfos', async () => {
    addJsonData()
    let install = create()
    await install.fetchInfos({ a: '^0.0.1' })
    expect(install.resolvedInfos.size).toBe(4)
    expect(install.resolvedVersions).toEqual([
      { name: 'a', requirement: '^0.0.1', version: '0.0.1' },
      { name: 'b', requirement: '^1.0.0', version: '1.0.0' },
      { name: 'c', requirement: '^2.0.0', version: '2.0.0' },
      { name: 'b', requirement: '^2.0.0', version: '2.0.0' },
      { name: 'd', requirement: '^1.0.0', version: '1.0.0' },
      { name: 'd', requirement: '>= 0.0.1', version: '1.0.0' }
    ])
  })

  it('should linkDependencies', async () => {
    addJsonData()
    let install = create()
    await install.fetchInfos({ a: '^0.0.1' })
    let items: DependencyItem[] = []
    install.linkDependencies(undefined, items)
    expect(items).toEqual([])
    install.linkDependencies({ a: '^0.0.1' }, items)
    expect(items.length).toBe(5)
  })

  it('should retry download', async () => {
    let install = create()
    let fn = async () => {
      await install.download(new URL('res', url), 'res', '', 3, 10)
    }
    await expect(fn()).rejects.toThrow(Error)
    fn = async () => {
      await install.download(new URL('test.tgz', url), 'test.tgz', 'badsum')
    }
    await expect(fn()).rejects.toThrow(Error)
    let res = await install.download(new URL('test.tgz', url), 'test.tgz', '')
    expect(fs.existsSync(res)).toBe(true)
    fs.unlinkSync(res)
    res = await install.download(new URL('test.tgz', url), 'test.tgz', 'bf0d88712fc3dbf6e3ab9a6968c0b4232779dbc4')
    expect(fs.existsSync(res)).toBe(true)
    fs.unlinkSync(res)
  })

  it('should check exists and download items', async () => {
    let items: DependencyItem[] = []
    items.push({
      integrity: '',
      name: 'foo',
      resolved: `http://127.0.0.1:${httpPort}/foo.tgz`,
      satisfiedVersions: [],
      shasum: 'bf0d88712fc3dbf6e3ab9a6968c0b4232779dbc4',
      version: '0.0.1'
    })
    items.push({
      integrity: '',
      name: 'bar',
      resolved: `http://127.0.0.1:${httpPort}/bar.tgz`,
      satisfiedVersions: ['^0.0.1'],
      shasum: 'bf0d88712fc3dbf6e3ab9a6968c0b4232779dbc4',
      version: '0.0.2'
    })
    let install = create()
    let dest = path.join(install.modulesRoot, '.cache')
    fs.mkdirSync(dest, { recursive: true })
    let tarfile = path.resolve(__dirname, '../test.tar.gz')
    fs.copyFileSync(tarfile, path.join(dest, `foo.0.0.1.tgz`))
    let res = await install.downloadItems(items)
    expect(res.size).toBe(2)
  })

  it('should throw on error', async () => {
    let items: DependencyItem[] = []
    items.push({
      integrity: '',
      name: 'bar',
      resolved: `http://127.0.0.1:${httpPort}/bar.tgz`,
      satisfiedVersions: [],
      shasum: 'badsum',
      version: '0.0.2'
    })
    let install = create()
    let fn = async () => {
      await install.downloadItems(items)
    }
    await expect(fn()).rejects.toThrow(Error)
  })

  it('should no nothing if no dependencies', async () => {
    let msg: string
    let install = create(undefined, s => {
      msg = s
    })
    let directory = path.join(os.tmpdir(), uuid())
    let file = path.join(directory, 'package.json')
    writeJson(file, { dependencies: {} })
    await install.installDependencies(directory)
    expect(msg).toMatch('No dependencies')
    fs.rmSync(directory, { recursive: true })
  })

  it('should install dependencies ', async () => {
    createFiles = true
    addJsonData()
    let install = create()
    let directory = path.join(os.tmpdir(), uuid())
    fs.mkdirSync(directory, { recursive: true })
    let file = path.join(directory, 'package.json')
    writeJson(file, { dependencies: { a: '^0.0.1' } })
    await install.installDependencies(directory)
    let folder = path.join(directory, 'node_modules')
    let res = fs.readdirSync(folder)
    expect(res).toEqual(['a', 'b', 'c', 'd'])
    let obj = loadJson(path.join(folder, 'b/package.json')) as any
    expect(obj.version).toBe('1.0.0')
    obj = loadJson(path.join(folder, 'c/node_modules/b/package.json')) as any
    expect(obj.version).toBe('2.0.0')
    fs.rmSync(directory, { recursive: true })
  })
})
