define([
    'metapolator/errors'
  , 'util-logging/util-logging'
  , 'logging/callbackhandler'
  , 'logging/yamlformatter'
  , 'logging/logger-patch'
  , 'ufojs/errors'
  , 'obtain/obtain'
  , 'ufojs/plistLib/main'
  , 'ufojs/plistLib/IntObject'
  , './ProjectMaster'
  , './parameters/registry'
  , './parameters/outputConverter'
  , 'metapolator/models/MOM/Univers'
  , 'metapolator/models/Controller'
  , 'metapolator/models/CPS/RuleController'
  , 'ufojs/ufoLib/glifLib/GlyphSet'
  , './ImportController'
  , './UFOExportController'
  , './OTFExportController'
  , 'yaml'
  , 'io/zipUtil'
  , 'io/InMemory'
], function(
    errors
  , log
  , CallbackHandler
  , YAMLFormatter
  , LoggerRelog
  , ufoErrors
  , obtain
  , plistLib
  , IntObject
  , ProjectMaster
  , parameterRegistry
  , defaultParameters
  , Univers
  , ModelController
  , RuleController
  , GlyphSet
  , ImportController
  , UFOExportController
  , OTFExportController
  , yaml
  , zipUtil
  , InMemory
) {
    "use strict";

    var metainfoV3 = {
            creator: 'org.ufojs.lib'
          , formatVersion: new IntObject(3)
        }
      , ProjectError = errors.Project
      , KeyError = errors.Key
      , IONoEntryError = ufoErrors.IONoEntry
      ;

    function MetapolatorProject(io, baseDir, fsEvents) {
        this._io = io;
        this._data = {
            masters: {}
        };
        this._cache = {
            masters: {}
          , glyphClasses:{}
          , fontinfo: null
        };

        this.baseDir = baseDir || '.';
        this._fsEvents = fsEvents;
        this._updateChangedRuleHandlers = null;
        if(this._fsEvents) {
            this._fsEvents.on('change', this._fileChangeHandler.bind(this));
            // setting the defaults
            this.setUpdateChangedRuleHandlers();
        }

        Object.defineProperty(this, 'ruleController', {
            value: new RuleController(io, parameterRegistry, this.cpsDir)
        });

        this._controller = new ModelController(this.ruleController);
        this._log = new log.Logger().setLevel(log.Level.INFO);
        this._log.addHandler(new log.Handler());

        this._momCache = Object.create(null);
    }

    var _p = MetapolatorProject.prototype;
    _p.constructor = MetapolatorProject;
    Object.defineProperty(_p, 'dataDir', {
        get: function(){ return this.baseDir + '/data/com.metapolator';}
    });

    Object.defineProperty(_p, 'projectFile', {
        get: function(){ return this.dataDir + '/project.yaml';}
    });

    Object.defineProperty(_p, 'cpsDir', {
        get: function(){ return this.dataDir + '/cps';}
    });

    Object.defineProperty(_p, 'cpsOutputConverterFile', {
        get: function(){ return 'centreline-skeleton-to-symmetric-outline.cps'; }
    });

    Object.defineProperty(_p, 'cpsGlobalFile', {
        get: function(){ return 'global.cps'; }
    });

    Object.defineProperty(_p, 'layerContentsFile', {
        get: function(){ return this.baseDir+'/layercontents.plist'; }
    });

    Object.defineProperty(_p, 'groupsFileName', {
        value: 'groups.plist'
    });
    Object.defineProperty(_p, 'fontinfoFileName', {
        value: 'fontinfo.plist'
    });


    Object.defineProperty(_p, 'groupsFile', {
        get: function(){ return this.baseDir+'/' + this.groupsFileName; }
    });
    Object.defineProperty(_p, 'fontinfoFile', {
        get: function(){ return this.baseDir+'/' + this.fontinfoFileName; }
    });

    Object.defineProperty(_p, 'logFile', {
        get: function(){ return this.dataDir + '/log.yaml';}
    });

    /**
     * TODO: For the big refactoring:
     * We'll need a better strategy for events like this. A classical
     * subscription interface probably.
     *
     * This event is fired when a changed file triggered a call to
     * `this.controller.updateChangedRule` see `_p._fileChangeHandler below`
     *
     * This function is a very simple interface, to unset handlers, call it
     * without arguments. It is not possible to set multiple handlers.
     *
     */
    _p.setUpdateChangedRuleHandlers = function(callback, errback) {
        this._updateChangedRuleHandlers = [
            callback || null
          , errback || errors.unhandledPromise
        ];
    };

    _p._fileChangeHandler = function (path) {
        var match = path.indexOf(this.cpsDir)
          , sourceName
          ;
        if(match !== 0)
            return;
        // +1 to remove the leading slash
        sourceName = path.slice(this.cpsDir.length + 1);
        try {
            this.controller.updateChangedRule(true, sourceName)
                .then(this._updateChangedRuleHandlers[0], this._updateChangedRuleHandlers[1]);
        }
        catch(error) {
            // KeyError will be thrown by RuleController.replaceRule if
            // sourceName is unknown, which is expected at this point,
            // because that means that sourceName is unused.
            // NOTE: the KeyError is always thrown synchronously before any io happens
            if(!(error instanceof errors.Key))
                throw error;
        }
    };

    _p.getNewGlyphSet = function(async, dirName, glyphNameFunc, UFOVersion, options) {
        return GlyphSet.factory(
                    async, this._io, dirName, glyphNameFunc, UFOVersion, options);
    };

    _p._readPlist = obtain.factory(
        {
            'path': ['ufoDir', 'fileName',
                function(ufoDir, fileName){ return [ufoDir, fileName].join('/'); }]
          , 'data': ['contents', plistLib.readPlistFromString.bind(plistLib)]
          , 'contents': ['path','io',
                function(path, io){ return (io || this._io).readFile(false, path);}]
        }
      , {
            'contents': ['path', 'io',
                function(path, io){ return (io || this._io).readFile(true, path);}]
        }
      , ['ufoDir', 'fileName', 'io']
      , function(obtain){ return obtain('data'); }
    );

    _p._readUFOFormatVersion = obtain.factory(
        {
            'metainfo': [false, 'ufoDir', new obtain.Argument('metainfo.plist'), 'io', _p._readPlist]
          , 'formatVersion': ['metainfo', function(data){return data.formatVersion;}]
        }
      , {
            'metainfo': [true, 'ufoDir', new obtain.Argument('metainfo.plist'), 'io', _p._readPlist]
        }
      , ['ufoDir', 'io'/*optional*/]
      , function(obtain){ return obtain('formatVersion'); }
    );

    /**
     * Initialize a GlyphSet for the UFO at `ufoDir`. Read the
     * ufo format version before, to load the glyphset the right way.
     *
     * If the ufo version is 3 `layername` can be given as argument,
     * it defaults to the ufo v3 default "public.default"
     *
     * FIXME: Once ufoJS finished porting ufoLib/UFOReader, this functionality
     * will large be located there.
     */
    _p.getGlyphSet = obtain.factory(
        {
            'UFOVersion': [false, 'ufoDir', 'io', _p._readUFOFormatVersion]
          , 'dirName': ['ufoDir', 'layer', function(ufoDir, layer) {
                                    return [ufoDir, layer].join('/');}]
          , 'layer': ['UFOVersion', 'ufoDir', 'layerName', 'io',
            function(UFOVersion, ufoDir, layerName, io) {
                var layerContents;
                if(UFOVersion < 3)
                    return 'glyphs';
                layerContents = this._readPlist(false, ufoDir, 'layercontents.plist', io);
                return _getLayerDir(layerContents, layerName || 'public.default');
            }]
          , 'GlyphSet': [false, 'dirName', 'glyphNameFunc', 'UFOVersion', 'options', _p.getNewGlyphSet]
        }
      , {
            'UFOVersion': [true, 'ufoDir', 'io', _p._readUFOFormatVersion]
          , 'layer':['UFOVersion', 'ufoDir', 'layerName', '_callback', '_errback', 'io',
            function(UFOVersion, ufoDir, layerName, callback, errback, io) {
                if(UFOVersion < 3) {
                    setTimeout(callback.bind('glyphs'));
                    return;
                }
                this._readPlist(true, ufoDir, 'layercontents.plist', io)
                .then(function(layerContents) {
                    callback(_getLayerDir(layerContents, layerName || 'public.default'));
                })
                .then(undefined, errback);
            }]
          , 'GlyphSet': [true, 'dirName', 'glyphNameFunc', 'UFOVersion', 'options', _p.getNewGlyphSet]
        }
      , ['ufoDir', 'glyphNameFunc'/*optional*/, 'options'/*optional*/
                    , 'layerName'/*optional default: 'public.default'*/, 'io'/*optional*/]
      , function(obtain) {return obtain('GlyphSet');}
    );

    _p.init = function() {
        // FIXME: all I/O is synchronous for now

        this._io.mkDir(false, this.baseDir);

        // create baseDir/metainfo.plist
        this._io.writeFile(false, this.baseDir+'/metainfo.plist'
                                , plistLib.createPlistString(metainfoV3));

        // create dir baseDir/data
        this._io.mkDir(false, this.baseDir+'/data');
        // create dir baseDir/data/com.metapolator
        this._io.mkDir(false, this.dataDir);

        // project file:
        // create this.dataDir/project.yaml => yaml({})
        this._io.writeFile(false, this.projectFile, yaml.safeDump(this._data));

        // create dir this.dataDir/cps
        this._io.mkDir(false, this.cpsDir);

        // create layercontents.plist
        this._io.writeFile(false, this.layerContentsFile,
                                        plistLib.createPlistString([]));

        // the glyphs dir must be there to make the UFO valid, but we don't
        // use it currently :-(
        // create dir baseDir/glyphs
        this._createGlyphLayer('public.default', 'glyphs');

        // create default CPS output stage
        // this is the standard wiring of cps compounds etc.
        // we include it, so it can be studied and if needed changed
        this._io.writeFile(false, [this.cpsDir, '/', this.cpsOutputConverterFile].join(''),
                                        this.getDefaultCPS().toString());

        // this can be empty, all masters will use this by default
        this._io.writeFile(false, [this.cpsDir, '/', this.cpsGlobalFile].join(''),
                            '/* all masters use this CPS file by default*/');
    };

    _p.load = function() {
        // the files created in _p.init need to exist
        // however, we try to load only
        // this.baseDir+'/data/com.metapolator/project.yaml' as an indicator
        this._log.debug('loading ' + this.projectFile);
        var dataString = this._io.readFile(false, this.projectFile)
          , fh
          ;
        this._log.debug('loaded ' + dataString);
        this._data = yaml.safeLoad(dataString);

        // Add ConsoleHandler for debugging (also replays existing entries)
        this._log.addHandler(new log.ConsoleHandler());

        // Reload any saved log entries before adding CallbackHandler for new entries
        var logText, logRecords;
        try {
            logText = this._io.readFile(false, this.logFile);
        }
        catch (error) { // Ignore file not found
            if(!(error instanceof IONoEntryError))
                throw error;
        }
        try {
            logRecords = yaml.safeLoad(logText || "");
        }
        catch(e) { // Translate YAML errors
            throw new ProjectError('Invalid log file ' + e);
        }
        if(logRecords) {
            logRecords.forEach(function (obj) {
                this._log.relog(log.LogRecord.prototype.fromObject(obj));
            }, this);
        }

        // Add CallbackHandler to log to add new entries to the log file
        fh = new CallbackHandler(this._io.appendFile.bind(this._io, true, this.logFile));
        fh.setFormatter(new YAMLFormatter());
        this._log.addHandler(fh);
    };

    /**
     * return a ParameterCollection with the default CPS wiring, as the
     * importer expects it.
     */
    _p.getDefaultCPS = function() {
        return defaultParameters;
    };

    _p.hasMaster = function(masterName) {
        return masterName in this._data.masters;
    };

    Object.defineProperty(_p, 'masters', {
        get: function(){ return Object.keys(this._data.masters); }
    });

    Object.defineProperty(_p, 'controller', {
        get: function(){ return this._controller; }
    });

    _p._createGlyphLayer = function(name, layerDirName) {
        if(layerDirName === undefined)
            layerDirName = 'glyphs.' + name;

        var layerDir = [this.baseDir,'/',layerDirName].join('');

        // read layercontents.plist
        var layercontents = plistLib.readPlistFromString(
                this._io.readFile(false, this.layerContentsFile));

        // see if there is a layer with this name
        for(var i=0;i<layercontents.length;i++)
            if(layercontents[i][0] === name)
                throw new ProjectError('A glyph layer with name "'+name
                                                +'" already exists.');

        // create new layer dir
        this._io.mkDir(false, layerDir);

        // store layer in layercontents
        layercontents.push([name, layerDirName]);
        this._io.writeFile(false, this.layerContentsFile,
                                    plistLib.createPlistString(layercontents));

        // create empty layerDir/contents.plist
        this._io.writeFile(false, layerDir + '/contents.plist',
                                        plistLib.createPlistString({}));
    };

    /**
     * Delete a glyph layer.
     *
     * FIXME: Currently, only works properly if no glyphs are defined:
     * simply removes the plist and then tries to delete the directory.
     * Also removes the glyph layer from layercontents.plist.
     *
     */
    _p._deleteGlyphLayer = function(name) {
        var layerDir = this._getLayerDir(name)
          , layerIndex;

        // Read layercontents.plist
        var layercontents = plistLib.readPlistFromString(
                this._io.readFile(false, this.layerContentsFile));

        // Find the layer with this name
        layerIndex = null;
        for(var i=0;i<layercontents.length;i++) {
            if(layercontents[i][0] === name) {
                layerIndex = i;
                break;
            }
        }
        if (layerIndex === null)
            throw new ProjectError('No such glyph layer "'+name+'".');
        layercontents.splice(layerIndex, 1);

        // Update layercontents
        this._io.writeFile(false, this.layerContentsFile,
                           plistLib.createPlistString(layercontents));

        // Remove layer dir and its contents
        this._io.rmDirRecursive(false, layerDir);
    };

    /**
     * lookup a name in a laycontents list as defined for layercontents.plist
     */
    function _getLayerDir(layercontents, name) {
        var layerDir;
        for(var i=0;i<layercontents.length;i++)
            if(layercontents[i][0] === name) {
                layerDir = layercontents[i][1];
                break;
            }
        if(!layerDir)
            throw new KeyError('Layer named "' + name + '" not found.');
        return layerDir;
    }
    /**
     * Returns the path needed to instantiate a GlyphSet for this project
     */
    _p._getLayerDir = function(name) {
        // read layercontents.plist
        var layercontents = plistLib.readPlistFromString(
                this._io.readFile(false, this.layerContentsFile))
          , layerDir = [this.baseDir, _getLayerDir(layercontents, name)].join('/')
          ;
        if(!this._io.pathExists(false, layerDir + '/'))
            throw new KeyError('Layer directory "' + layerDir
                                + '" does not exist, but is mentioned in '
                                +'layercontents.plist.');
        return layerDir;
    };

    /**
     * Create a master entry for this masterName, with the given cpsFile
     * and skeleton.
     *
     * Also creates an entry in layercontents.plist: `skeleton`,
     * glyphs.`skeleton`
     *
     * If any element does not exist, it is assumed the caller will create
     * it before attempting to use the font.
     *
     */
    _p.createMaster = function(masterName, cpsFile, skeleton) {
        // get the name for this master from the CLI
        if(this.hasMaster(masterName))
            throw new ProjectError('Master "'+masterName+'" already exists.');
        var master = {cpsFile: cpsFile};
        this._data.masters[masterName] = master;

        // create a skeleton layer for this master
        master.skeleton = skeleton;
        if (skeleton === 'skeleton.' + masterName)
            this._createGlyphLayer(master.skeleton);

        this._io.writeFile(false, this.projectFile, yaml.safeDump(this._data));

        return this.getMaster(masterName);
    };

    /**
     * delete a master entry for this masterName
     *
     * and remove entry in layercontents.plist:
     * skeleton.masterName, glyphs.skeleton.masterName
     *
     */
    _p.deleteMaster = function(masterName) {
        // get the name for this master from the cli
        if(!this.hasMaster(masterName))
            throw new ProjectError('No such Master "'+masterName+'".');
        var master = this._data.masters[masterName];

        // Remove CPS file
        this.getMaster(masterName).deleteCPS(masterName + '.cps');

        // Remove skeleton layer for this master
        if (master.skeleton === 'skeleton.' + masterName)
            this._deleteGlyphLayer(master.skeleton);

        // Remove project entry
        delete this._data.masters[masterName];

        // Update project file
        this._io.writeFile(false, this.projectFile, yaml.safeDump(this._data));

        // FIXME: Check we successfully deleted it
        return true;
    };

    _p._getMaster = function(masterName) {
        var master =  this._data.masters[masterName]
          , glyphSetDir = this._getLayerDir(master.skeleton)
          ;
        return new ProjectMaster(this._io, this, masterName, glyphSetDir, master.cpsFile);
    };

    _p.getMaster = function(masterName) {
        if(!this.hasMaster(masterName))
            throw new KeyError('Master "'+masterName+'" not in project');
        if(!this._cache.masters[masterName]) {
            this._cache.masters[masterName] = this._getMaster(masterName);
        }
        return this._cache.masters[masterName];
    };

    _p.open = function(masterName) {
        if(!this._controller.hasMaster(masterName)) {
            // this._log.warning('open', masterName)
            var master = this.getMaster(masterName)
            , skeleton = this._data.masters[masterName].skeleton
            , sourceMOM
            , momMaster
            ;
            // FIXME: Bad implementation, we need much better management
            // for masters etc. ALSO, if skeleton is the same, we should
            // rather try to have a single MOM object for this, maybe with
            // some kind of proxying to enable different "master.id"s
            sourceMOM = this._momCache[skeleton];
            if(!sourceMOM)
                sourceMOM = this._momCache[skeleton] = master.loadMOM();
            momMaster = sourceMOM.clone();

            momMaster.id = masterName;
            this._controller.addMaster(momMaster, master._cpsFile);
        }
        return this._controller;
    };

    /**
     * The blob parameter must be data representing a file containing one or more
     * UFOs encoded with the following packaging scheme:
     *
     * upload.zip
     *     ├── master1.ufo.zip
     *     │    └── master1.ufo
     *     ├── master2.ufo.zip
     *     │    └── master2.ufo
     *     └── master3.ufo.zip
     *          └── master3.ufo
     */
    _p.importZippedUFOMasters = function(blob) {
        var mem_io = new InMemory()
          , importedMasters = Array()
          ;

        zipUtil.unpack(false, blob, mem_io, "");

        var dirs = mem_io.readDir(false, "/")
          , baseDir = dirs[0]
          , names = mem_io.readDir(false, baseDir)
          , n, l
          ;

        for (n=0, l=names.length; n<l; n++){
            var name = names[n]
              , UFOZip = baseDir + name
              , another_blob
              ;

            another_blob = mem_io.readFile(false, UFOZip);
            zipUtil.unpack(false, another_blob, mem_io, baseDir);
        }

        names = mem_io.readDir(false, baseDir);
        for (n=0, l=names.length; n<l; n++){
            var name = names[n];
            if (name[name.length-1]=='/'){
                // This sourceUFODir name may be wrong in some cases.
                //   We need a more robust implementation.
                //   The current implementation works only for
                //   the UFO packing scheme described above.
                var sourceUFODir = baseDir + name.split("/")[0]
                  , glyphs = undefined
                  , masterName = name.split(".ufo/")[0]
                  ;

                //FIXME: Replacing by spaces by '_' can be removed once we have proper escaping implemented.
                //       Metapolator dislikes spaces in master names as well as anything that has a meaning
                //       in a selector/cps. (.#>:(){}) etc.
                masterName = masterName.split(' ').join('_');

                this.import(masterName, sourceUFODir, glyphs, mem_io);
                importedMasters.push(masterName);
            }
        }

        return importedMasters;
    };

    _p.import = function(masterName, sourceUFODir, glyphs, io) {
        var importer = new ImportController( io || this._io, this._log, this,
                                             masterName, sourceUFODir);
        importer.import(glyphs);

        this._importGroupsFile(sourceUFODir, false);
        this._importFontInfoFile(sourceUFODir, false);
    };

    /**
     * If there is no 'targetFile' in the project but the import
     * has one, we do the import.
     *
     * If there is a 'targetFile' in the project and overide is true
     * we overide by doing the import.
     * Otherwise, we skip importing the file.
     *
     * This rule may get changed in the future, but having the first
     * possible file also imported into the project is better than not
     * having it to happen.
     *
     * Also, ufoJS can't validate this file at the moment
     * however, we can try to parse it with plistlib and see if it works.
     */
    _p._importPListFile = function(sourceUFODir, override, filename, targetFile ) {
        var sourceFile = [sourceUFODir, filename].join('/')
          , targetExists
          , content
          ;

        targetExists = this._io.pathExists(false, targetFile);
        if(targetExists && !override) {
            this._log.warning(filename + ' exists in the project, skipping import.');
            return;
        }

        if(!this._io.pathExists(false, sourceFile)) {
            this._log.warning('No ' + filename + ' found for import.');
            return;
        }

        this._log.warning('Importing '+filename+' into the project.');
        if(targetExists)
            this._log.warning('The existing '+filename+' will be overridden.');

        content = this._io.readFile(false, sourceFile);
        try {
            // Just a rough look if we can parse it, we are not interested
            // in the result of parsing at the moment.
            // TODO: validation (this is a task for ufoJS)
            plistLib.readPlistFromString(content);
        }
        catch(error) {
            this._log.warning('Import of '+filename+' failed when trying to '
                                    +'parse it as a plist:\n'+ error);
        }
        this._io.writeFile(false, targetFile, content);
        this._log.warning('Import of '+filename+' OK.\n');
    };


    /**
     * Only imports groups.plist if we don't have one already and
     * !override.
     *
     * @see _importPListFile
     */
    _p._importGroupsFile = function(sourceUFODir, override) {
        this._importPListFile( sourceUFODir, override,
                               this.groupsFileName, this.groupsFile );
    };

    /**
     * Only imports fontinfo.plist if we don't have one already and
     * !override.
     *
     * @see _importPListFile
     */
    _p._importFontInfoFile = function(sourceUFODir, override) {
        this._importPListFile( sourceUFODir, override,
                               this.fontinfoFileName, this.fontinfoFile );
    };

    _p.getUFOExportGenerator = function ( masterName, dirName, precision) {
        var io = new InMemory()
          , exportController = new UFOExportController(io, this, masterName, dirName, precision)
          , generator = exportController.exportGenerator()
          ;
        return [generator, io];
    };

    _p.getOTFExportGenerator = function ( masterName, targetName, precision) {
        var io = new InMemory()
          , exportController = new OTFExportController(io, this, masterName, targetName, precision)
          , generator = exportController.exportGenerator()
          ;
        return [generator, io];
    }

    _p.exportInstance = function(masterName, targetFileName, precision) {
        if (targetFileName.slice(-8) === '.ufo.zip'){
            var zipped = this.getZippedInstance(masterName, targetFileName.slice(0,-4), precision, 'nodebuffer');
            this._io.writeFile(false, targetFileName, zipped);
        } else if (targetFileName.slice(-4) === '.otf'){
            var otf = this.getOTFInstance(masterName, this);
            this._io.writeFile(false, targetFileName, otf);
        } else {
            new UFOExportController(this._io, this, masterName, targetFileName, precision).doExport();
        }
    };

    _p.getZippedInstance = function(masterName, targetDirName, precision, dataType) {
        var mem_io = new InMemory();
        new UFOExportController(mem_io, this, masterName, targetDirName, precision).doExport();
        return zipUtil.encode(false, mem_io, targetDirName, dataType);
    };

    _p.getZipFromIo = zipUtil.encode;

    _p.getOTFInstance = function(masterName, project) {
        var model = project.open(masterName)
          , master = model.query('master#' + masterName)
          , targetName = masterName + ".otf"
          , mem_io = new InMemory()
          , precision = -1
          ;
        new OTFExportController(mem_io, project, masterName, targetName, precision).do_export();
        return new Buffer(Int8Array(mem_io.readFile(false, targetName)));
    };

    _p._getGlyphClassesReverseLookup = function() {
        var result = {}
          , data
          , groups
          , group, i, glyphName
          ;
        try {
            data = this._io.readFile(false,  this.groupsFile);
        }
        catch(error) {
            if(error instanceof IONoEntryError) {
                // this is legal, we simply have no groups file
                this._log.warning('No groups.plist file found, thus no glyph classes are defined.');
                return result;
            }
            throw error;
        }
        groups = plistLib.readPlistFromString(data);

        for(group in groups) {
            for(i=0;i<groups[group].length;i++) {
                glyphName = groups[group][i];
                if(!(glyphName in result))
                    result[glyphName] = [];
                result[glyphName].push(group);
            }
        }
        return result;
    };

    _p.getGlyphClassesReverseLookup = function() {
        if(!this._cache.glyphClasses.reverseLookup)
            this._cache.glyphClasses.reverseLookup = this._getGlyphClassesReverseLookup();

        return this._cache.glyphClasses.reverseLookup;
    };

    _p._getFontinfo = function() {
        var data;
        try {
            data = this._io.readFile(false,  this.fontinfoFile);
        }
        catch(error) {
            if(error instanceof IONoEntryError) {
                // this is legal, we have no fontinfo
                this._log.warning('No fontinfo found, fallback to minimal (builtin) fontinfo.');
                return minimalFontinfo;
            }
            throw error;
        }
        return plistLib.readPlistFromString(data);
    };

    _p.getFontinfo = function() {
        var fontinfo = this._cache.fontinfo;
        if(!fontinfo)
            this._cache.fontinfo = fontinfo = this._getFontinfo();
        return fontinfo;
    };

    return MetapolatorProject;
});
