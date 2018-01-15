const fs = require( 'fs' );
const path = require( 'path' );

const chalk = require( 'chalk' );
const got = require( 'got' );
const Queue = require( 'bull' );
const now = require( 'performance-now' );


const indexers = require( './indexers/' );

const API_TOKEN = process.env.API_TOKEN;

if ( !API_TOKEN ) {
    throw new Error( 'Unable to load API token' );
}

if ( !process.env.REDIS_URL ) {
    throw new Error( 'Got no queue string, exiting' );
}

const requestOptions = {
    headers: {
        Authorization: `Bearer ${ API_TOKEN }`,
    },
    json: true,
};

const redditQueue = new Queue(
    'reddit-posts',
    process.env.REDIS_URL,
);

const addJobToQueue = function addJobToQueue ( accountId, gameIdentifier, jobData ) {
    // console.log( `Adding job ${ jobData.data.id }` );

    return redditQueue.add( {
        accountId: accountId,
        game: gameIdentifier,
        post: jobData,
    }, {
        removeOnComplete: true,
        jobId: jobData.data.id,
    } )
};

const sleep = function sleep( ms ) {
    // console.log( `Sleeping for ${ ms }ms` );

    return new Promise( ( resolve ) => {
        setTimeout( resolve, ms );
    } );
};

console.time( 'Indexer' );

process.on( 'exit', () => {
    console.timeEnd( 'Indexer' );
} );

const indexGame = function indexGame ( gameData ) {
    // console.log( `Indexing ${ gameData.identifier }` );
    return new Promise( async ( resolve, reject ) => {
        // console.log( `Checking ${ gameData.accounts.length } devs for ${ gameData.identifier }` );

        for ( let accountIndex = 0; accountIndex < gameData.accounts.length; accountIndex = accountIndex + 1 ) {
            // console.log( `Finding posts for ${ gameData.accounts[ accountIndex ].identifier }` );
            const start = now();
            const newPosts = await indexers.reddit.findNewPosts( gameData.accounts[ accountIndex ].identifier, gameData.allowedSections, gameData.disallowedSections )
            let addJobs = [];

            for( let i = 0; i < newPosts.length; i = i + 1 ) {
                addJobs.push( addJobToQueue( gameData.accounts[ accountIndex ].id, gameData.identifier, newPosts[ i ] ) );
            }

            await Promise.all( addJobs );

            const end = now();

            // Make sure we don't do more than 1 request / 1000 ms
            if ( end - start < 1000 ) {
                await sleep( 1000 - ( end - start ) );
            }
        }

        resolve();
    } );
};


const run = async function run () {
    const gamePromises = [];
    let gamesResponse = false;

    try {
        gamesResponse = await got( `https://api.kokarn.com/games`, requestOptions );
    } catch ( gameDataError ) {
        throw gameDataError;
    }

    const gameData = {};

    gamesResponse.body.data.forEach( ( gameConfig ) => {
        if ( gameConfig.config && gameConfig.config.sources ) {
            gameData[ gameConfig.identifier ] = gameConfig.config.sources;
        }
    } );

    Object.keys( gameData ).forEach( ( gameIdentifier ) => {
        gamePromises.push( got( `https://api.kokarn.com/${ gameIdentifier }/accounts?active=1`, requestOptions )
            .then( ( accountResponse ) => {
                const accounts = [];

                for ( let i = 0; i < accountResponse.body.data.length; i = i + 1 ) {
                    if ( accountResponse.body.data[ i ].service === 'Reddit' ) {
                        accounts.push( accountResponse.body.data[ i ] );
                    }
                }

                return {
                    accounts: accounts,
                    identifier: gameIdentifier,
                    allowedSections: gameData[ gameIdentifier ][ 'Reddit' ].allowedSections,
                    disallowedSections: gameData[ gameIdentifier ][ 'Reddit' ].disallowedSections,
                };
            } )
            .catch( ( something ) => {
                console.log( 'GOT ERROR' );
                console.log( something );
            } )
        );
    } );

    Promise.all( gamePromises )
        .then( async ( gameData ) => {
            for ( let gameIndex = 0; gameIndex < gameData.length; gameIndex = gameIndex + 1 ) {
                await indexGame( gameData[ gameIndex ] )
                    .catch( ( indexError ) => {
                        throw indexError;
                    } );
            }

            // Close queue after all games are indexed
            redditQueue.close();
        } )
        .catch( ( error ) => {
            console.log( error );
        } );
};

run();
