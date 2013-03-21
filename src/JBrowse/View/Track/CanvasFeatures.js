/**
 * Feature track that draws features using HTML5 canvas elements.
 */

define( [
            'dojo/_base/declare',
            'dojo/dom-construct',
            'dojo/_base/array',
            'dojo/dom-geometry',
            'dojo/Deferred',
            'dojo/on',
            'JBrowse/View/GranularRectLayout',
            'JBrowse/View/Track/BlockBased',
            'JBrowse/Errors',
            'JBrowse/View/Track/FeatureDetailMixin'
        ],
        function(
            declare,
            dom,
            array,
            domGeom,
            Deferred,
            on,
            Layout,
            BlockBasedTrack,
            Errors,
            FeatureDetailMixin
        ) {

/**
 *  inner class that indexes feature layout rectangles (fRects) (which
 *  include features) by canvas pixel coordinate, and by unique ID.
 *
 *  We have one of these indexes in each block.
 */
var FRectIndex = declare( null,  {
    constructor: function( args ) {
        var height = args.h;
        var width  = args.w;

        this.dims = { h: height, w: width };

        this.byCoord = new Array( width );
        for( var i = 0; i < width; i++ )
            this.byCoord[i] = new Array( height );

        this.byID = {};
    },

    getByID: function( id ) {
        return this.byID[id];
    },

    getByCoord: function( x, y ) {
        return (this.byCoord[x]||[])[y];
    },

    _clampCoord: function( val, lBound, uBound ) {
        return Math.round( Math.max( lBound, Math.min( val, uBound ) ) );
    },

    addAll: function( fRects ) {
        var byCoord = this.byCoord;
        var byID = this.byID;
        var cW = this.dims.w;
        var cH = this.dims.h;
        array.forEach( fRects, function( fRect ) {
            if( ! fRect )
                return;

            // by coord
            for( var i = 0; i < fRect.w; ++i ) {
                for( var j = 0; j < fRect.h; ++j ) {
                    var x = this._clampCoord( fRect.l + i, 0, cW-1 );
                    var y = this._clampCoord( fRect.t + j, 0, cH-1 );
                    byCoord[x][y] = fRect;
                }
            }

            // by ID
            byID[ fRect.f.id() ] = fRect;
        }, this );
    }
});

return declare( [BlockBasedTrack,FeatureDetailMixin], {

    constructor: function( args ) {
        this._setupEventHandlers();
        this.glyphsLoaded = {};
        this.regionStats = {};
        this.showLabels = this.config.style.showLabels;
    },

    browserHasCanvas: function( blockIndex, block ) {
        try {
            document.createElement('canvas').getContext('2d').fillStyle = 'red';
            return true;
        } catch( e ) {
            return false;
        }
    },

    _defaultConfig: function() {
        return {
            maxFeatureScreenDensity: 400,

            // default glyph class to use
            glyph: 'JBrowse/View/FeatureGlyph/Rectangle',

            // maximum number of pixels on each side of a
            // feature's bounding coordinates that a glyph is
            // allowed to use
            maxFeatureGlyphExpansion: 500,

            style: {

                // not configured by users
                _defaultHistScale: 4,
                _defaultLabelScale: 30,
                _defaultDescriptionScale: 120,

                showLabels: true
            }
        };
    },

    fillBlock: function( args ) {
        var blockIndex = args.blockIndex;
        var block = args.block;
        var leftBase = args.leftBase;
        var rightBase = args.rightBase;
        var scale = args.scale;

        if( ! this.browserHasCanvas( blockIndex, block ) ) {
            this.fatalError = 'This browser does not support HTML canvas elements.';
            this.fillBlockError( blockIndex, block, this.fatalError );
            return;
        }

        var fill = dojo.hitch( this, function( stats ) {

                // calculate some additional view parameters that
                // might depend on the feature stats and add them to
                // the view args we pass down
                var renderHints = dojo.mixin(
                    {
                        stats: stats,
                        showFeatures: scale >= ( this.config.style.featureScale
                                                 || stats.featureDensity / this.config.maxFeatureScreenDensity ),
                        showLabels: this.showLabels
                            && scale >= ( this.config.style.labelScale
                                          || stats.featureDensity * this.config.style._defaultLabelScale ),
                        showDescriptions: this.showLabels
                            && scale >= ( this.config.style.descriptionScale
                                          || stats.featureDensity * this.config.style._defaultDescriptionScale)
                    },
                    args
                );

                if( renderHints.showFeatures ) {
                    this.fillFeatures( dojo.mixin( renderHints, args ) );
                }
                else {
                    this.fillTooManyFeaturesMessage(
                        blockIndex,
                        block,
                        scale
                    );
                    args.finishCallback();
                }
            });

        this.store.getGlobalStats(
            fill,
            dojo.hitch( this, function(e) {
                            this._handleError(e);
                            args.finishCallback(e);
                        })
        );
    },

    _getLayout: function( scale ) {
        // create the layout if we need to, and if we can
        if( ! this.layout || this.layout.pitchX != 4/scale ) {
            // if no layoutPitchY configured, calculate it from the
            // height and marginBottom (parseInt in case one or both are functions), or default to 3 if the
            // calculation didn't result in anything sensible.
            var pitchY = this.config.layoutPitchY || 4;
            this.layout = new Layout({ pitchX: 4/scale, pitchY: pitchY });
        }

        return this.layout;
    },

    /**
     * Returns a promise for the appropriate glyph for the given
     * feature and args.
     */
    getGlyph: function( viewArgs, feature, callback ) {
        var glyphClassName = this.getConfForFeature( 'glyph', feature );
        var glyph;
        if(( glyph = this.glyphsLoaded[glyphClassName] )) {
            callback( glyph );
        }
        else {
            var thisB = this;
            require( [glyphClassName], function( GlyphClass ) {
                glyph = thisB.glyphsLoaded[glyphClassName] =
                    new GlyphClass({ track: thisB, config: thisB.config, browser: thisB.browser });

                callback( glyph );
            });
        }
    },

    fillFeatures: function( args ) {
        var thisB = this;

        var blockIndex = args.blockIndex;
        var block = args.block;
        var scale = args.scale;
        var leftBase = args.leftBase;
        var rightBase = args.rightBase;
        var finishCallback = args.finishCallback;

        var timedOut = false;
        if( this.config.blockDisplayTimeout )
            window.setTimeout( function() { timedOut = true; }, this.config.blockDisplayTimeout );

        var fRects = [];

        // count of how many features are queued up to be laid out
        var featuresInProgress = 0;
        // promise that resolved when all the features have gotten laid out by their glyphs
        var featuresLaidOut = new Deferred();
        // flag that tells when all features have been read from the
        // store (not necessarily laid out yet)
        var allFeaturesRead = false;

        var errorCallback = dojo.hitch( thisB, function(e) {
                                            this._handleError(e);
                                            finishCallback(e);
                                        });

        var layout = this._getLayout( scale );

        // query for a slightly larger region than the block, so that
        // we can draw any pieces of glyphs that overlap this block,
        // but the feature of which does not actually lie in the block
        // (long labels that extend outside the feature's bounds, for
        // example)
        var bpExpansion = Math.round( this.config.maxFeatureGlyphExpansion / scale );

        var region = { ref: this.refSeq.name,
                       start: Math.max( 0, leftBase - bpExpansion ),
                       end: rightBase + bpExpansion
                     };
        this.store.getFeatures( region,

                                function( feature ) {
                                    if( timedOut )
                                        throw new Errors.TrackBlockTimeout({
                                            track: thisB,
                                            blockIndex: blockIndex,
                                            block: block
                                        });

                                    fRects.push( null ); // put a placeholder in the fRects array
                                    featuresInProgress++;
                                    var rectNumber = fRects.length-1;
                                    thisB.getGlyph(
                                        args, feature,
                                        function( glyph ) {
                                            var fRect = glyph.layoutFeature({
                                                            view: args,
                                                            layout: layout,
                                                            feature: feature
                                                        });
                                            fRect.glyph = glyph;
                                            if( !( fRect.l >= block.domNode.offsetWidth || fRect.l+fRect.w < 0 ) )
                                                fRects[rectNumber] = fRect;

                                            // this might happen after all the features have been sent from the store
                                            if( ! --featuresInProgress && allFeaturesRead ) {
                                                featuresLaidOut.resolve();
                                            }
                                        },
                                        errorCallback
                                    );
                                },

                                // callback when all features sent
                                function () {
                                    allFeaturesRead = true;
                                    if( ! featuresInProgress && ! featuresLaidOut.isFulfilled() ) {
                                        featuresLaidOut.resolve();
                                    }

                                    featuresLaidOut.then( function() {

                                        var totalHeight = layout.getTotalHeight();
                                        var c = block.featureCanvas =
                                            dojo.create(
                                                'canvas',
                                                { height: totalHeight,
                                                  width:  block.domNode.offsetWidth+1,
                                                  style: {
                                                      cursor: 'default',
                                                      height: totalHeight+'px'
                                                  },
                                                  innerHTML: 'Your web browser cannot display this type of track.',
                                                  className: 'canvas-track'
                                                },
                                                block.domNode
                                            );
                                        thisB.heightUpdate( totalHeight,
                                                            blockIndex );

                                        thisB.renderFeatures( args, fRects );

                                        thisB.renderClickMap( args, fRects );

                                        finishCallback();
                                    });
                                },
                                errorCallback
                              );
    },

    startZoom: function() {
        this.inherited( arguments );

        array.forEach( this.blocks, function(b) {
            try {
                b.featureCanvas.style.width = '100%';
            } catch(e) {};
        });
    },

    endZoom: function() {
        array.forEach( this.blocks, function(b) {
            try {
                delete b.featureCanvas.style.width;
            } catch(e) {};
        });

        this.clear();
        this.inherited( arguments );
    },

    renderClickMap: function( args, fRects ) {
        var thisB = this;
        var block = args.block;

        // make an index of the fRects by ID, and by coordinate, and
        // store it in the block
        var index = new FRectIndex({ h: block.featureCanvas.height, w: block.featureCanvas.width });
        block.fRectIndex = index;
        index.addAll( fRects );

        if( ! block.featureCanvas || ! block.featureCanvas.getContext('2d') ) {
            console.warn( "No 2d context available from canvas" );
            return;
        }

        // make features get highlighted on mouse move
        block.own(
            on( block.featureCanvas, 'mousemove', function( evt ) {
                domGeom.normalizeEvent( evt );
                var fRect = index.getByCoord( evt.layerX, evt.layerY );
                thisB.mouseoverFeature( fRect && fRect.f );
            }),
            on( block.featureCanvas, 'mouseout', function( evt ) {
                    thisB.mouseoverFeature( undefined );
                })
        );

        // connect up the event handlers
        for( var event in this.eventHandlers ) {
            var handler = this.eventHandlers[event];
            block.own(
                on( block.featureCanvas, event, function( evt ) {
                    domGeom.normalizeEvent( evt );
                    var fRect = index.getByCoord( evt.layerX, evt.layerY );
                    if( fRect ) {
                        handler.call({
                            track: thisB,
                            feature: fRect.f,
                            fRect: fRect,
                            callbackArgs: [ thisB, fRect.f ]
                        });
                    }
                })
            );
        }
    },

    getRenderingContext: function( viewArgs ) {
        if( ! viewArgs.block || ! viewArgs.block.featureCanvas )
            return null;
        try {
            var ctx = viewArgs.block.featureCanvas.getContext('2d');
            // ctx.translate( viewArgs.block.offsetLeft - this.featureCanvas.offsetLeft, 0 );
            // console.log( viewArgs.blockIndex, 'block offset', viewArgs.block.offsetLeft - this.featureCanvas.offsetLeft );
            return ctx;
        } catch(e) {
            console.error(e, e.stack);
            return null;
        }
    },

    // draw the features on the canvas
    renderFeatures: function( args, fRects ) {
        var context = this.getRenderingContext( args );
        if( context ) {
            var thisB = this;
            array.forEach( fRects, function( fRect ) {
                if( fRect )
                    thisB.renderFeature( context, args.block, fRect );
            });
        }
    },

    // given viewargs and a feature object, highlight that feature in
    // all blocks.  if feature is undefined or null, unhighlight any currently
    // highlighted feature
    mouseoverFeature: function( feature ) {

        if( this.lastMouseover == feature )
            return;

        array.forEach( this.blocks, function( block, i ) {
            if( ! block )
                return;
            var context = this.getRenderingContext({ block: block, leftBase: block.startBase, scale: block.scale });
            if( ! context )
                return;

            if( this.lastMouseover ) {
                var r = block.fRectIndex.getByID( this.lastMouseover.id() );
                if( r )
                    this.renderFeature( context, block, r );
            }

            if( feature ) {
                var fRect = block.fRectIndex.getByID( feature.id() );
                if( ! fRect )
                    return;

                fRect.glyph.mouseoverFeature( context, block, fRect );
            }
        }, this );

        this.lastMouseover = feature;
    },

    cleanupBlock: function(block) {
        // garbage collect the layout
        if ( block && this.layout )
            this.layout.discardRange( block.startBase, block.endBase );
    },

    // draw each feature
    renderFeature: function( context, block, fRect ) {
        fRect.glyph.renderFeature( context, block, fRect );
    }
});
});