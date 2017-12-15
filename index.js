const fs = require( 'fs' );
const path = require( 'path' );

const chalk = require( 'chalk' );
const got = require( 'got' );
const Queue = require( 'bull' );
const now = require( 'performance-now' );

const indexers = require( './indexers/' );

const API_TOKEN = process.env.API_TOKEN;
const QUEUE = JSON.parse( process.env.QUEUE );

if ( !API_TOKEN ) {
    throw new Error( 'Unable to load API token' );
}

if ( !QUEUE ) {
    throw new Error( 'Got no queue, exiting' );
}

const gameData = require( './config/games.json' );

const requestOptions = {
    headers: {
        Authorization: `Bearer ${ API_TOKEN }`,
    },
    json: true,
};

const redditQueue = new Queue(
    'reddit',
    {
        redis: QUEUE,
    }
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
        const indexer = new indexers[ 'Reddit' ];

        // console.log( `Checking ${ gameData.accounts.length } devs for ${ gameData.identifier }` );

        for ( let accountIndex = 0; accountIndex < gameData.accounts.length; accountIndex = accountIndex + 1 ) {
            // console.log( `Finding posts for ${ gameData.accounts[ accountIndex ].identifier }` );
            const start = now();
            const newPosts = await indexer.findNewPosts( gameData.accounts[ accountIndex ].identifier, gameData.allowedSections, gameData.disallowedSections )
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


const run = function run () {
    const gamePromises = [];
    // return got( `https://api.kokarn.com/${ game.identifier }/hashes`, requestOptions );

    Object.keys( gameData ).forEach( ( gameIdentifier ) => {
        gamePromises.push( got( `https://api.kokarn.com/${ gameIdentifier }/accounts?active=1`, requestOptions )
            .then( ( accountResponse ) => {
                return {
                    accounts: accountResponse.body.data,
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
                const accounts = [];

                for ( let i = 0; i < gameData[ gameIndex ].accounts.length; i = i + 1 ) {
                    if ( gameData[ gameIndex ].accounts[ i ].service === 'Reddit' ) {
                        accounts.push( gameData[ gameIndex ].accounts[ i ] );
                    }
                }

                gameData[ gameIndex ].accounts = accounts;

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
